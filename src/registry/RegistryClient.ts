import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { RegistryClient as RegistrySdk } from '@uluops/registry-sdk';
import type { ResolvedConfig } from '../types/config.js';
import type { DefinitionType } from '../types/execution.js';
import type { AgentDefinition } from '../types/agent.js';
import type { ResolvedDefinition, DefinitionSummary } from '../types/registry.js';
import { ConfigurationError, SubscriptionRequiredError, IntegrityError } from '../errors/index.js';
import { normalizeDefinition, DefinitionValidationError } from './normalize.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_MODEL_ALIAS } from '../constants.js';
import type { Logger } from '@uluops/sdk-core';
import { computeHash, computePromptHash, verifyHash, verifyPromptHash } from '@uluops/sdk-core';
import { SdkApiError } from '@uluops/sdk-core/errors';

/** Caller-supplied integrity pins, verified at resolve time against a trusted channel. */
export interface ResolvePinOptions {
  /** Expected YAML hash (`sha256:...`). Verified via computeHash(resolved.yaml). */
  expectedHash?: string;
  /** Expected rendered-prompt hash (`sha256:...`). Verified via computePromptHash(runtime.prompt). */
  expectedPromptHash?: string;
}

/**
 * Definition resolver with local development fallback.
 *
 * Delegates remote API calls to @uluops/registry-sdk (which handles retry,
 * rate limiting, error mapping, auth). Local file resolution is handled
 * in this class directly. Hash computation and verification are the
 * responsibility of the registry API server.
 *
 * SINGLE-ACTOR CONTRACT: each instance is bound to one API key + config
 * (passed in the constructor) and caches resolutions in an instance-scoped
 * Map. The cache is keyed by content identity (type:name@version), and
 * definitions are immutable per version, so the cache is safe under that
 * contract. Do NOT share a single instance across tenants or actors with
 * differing tier entitlements — instantiate one client per actor instead.
 * If multi-tenant orchestration becomes a requirement, the cache key must
 * be extended with an actor discriminator before the contract changes.
 */
export class RegistryClient {
  private cache = new Map<string, ResolvedDefinition>();
  private sdk: RegistrySdk;
  private logger: Logger;

  /** Expose underlying registry SDK for direct access (e.g., model catalog) */
  get registrySdk(): RegistrySdk {
    return this.sdk;
  }

  constructor(private config: ResolvedConfig, logger: Logger) {
    this.logger = logger;
    this.sdk = new RegistrySdk({
      apiKey: config.apiKey,
      baseUrl: config.registryUrl,
      timeout: config.timeout,
      onSecurityEvent: config.onSecurityEvent,
    });
  }

  /** Safe definition name pattern — alphanumeric, hyphens, underscores, dots, forward slashes */
  private static readonly SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/;

  /**
   * Resolve a definition by name and optional type.
   *
   * Resolution priority: in-memory cache → local files (if `localDefinitions`
   * is configured) → remote registry API. The returned `ResolvedDefinition`
   * carries the frozen `runtime.prompt` (`def.runtimeMd`) as published — it is
   * not a live re-render of the YAML.
   *
   * @param name - Definition name (e.g. `'code-validator'`). Validated against
   *   path-traversal before any filesystem or API use.
   * @param version - Optional exact version; omit for the latest published version.
   * @param type - Optional definition type (`agent`/`command`/`workflow`/`pipeline`).
   *   When omitted, the registry is searched to infer it (errors if ambiguous).
   * @param opts - Optional caller-pinned integrity hashes (`expectedHash`,
   *   `expectedPromptHash`). Verification runs fail-closed on every return path,
   *   including cache hits.
   * @returns The resolved definition with source YAML, frozen runtime prompt, and metadata.
   * @throws {ConfigurationError} If the name contains path-traversal sequences, or
   *   the definition cannot be found / is ambiguous in the registry.
   * @throws {IntegrityError} If a supplied `expectedHash`/`expectedPromptHash` does
   *   not match, or a prompt pin is supplied for a definition with no rendered prompt.
   * @throws {SubscriptionRequiredError} If the definition requires a higher subscription tier.
   * @example
   * ```typescript
   * // Latest version, type inferred:
   * const def = await registry.resolve('code-validator');
   *
   * // Pinned version + type, with fail-closed integrity verification:
   * const pinned = await registry.resolve('code-validator', '1.2.0', 'agent', {
   *   expectedHash: 'sha256:…',        // refuses execution if the YAML hash differs
   *   expectedPromptHash: 'sha256:…',  // refuses if the frozen rendered prompt differs
   * });
   * ```
   */
  async resolve(
    name: string,
    version?: string,
    type?: DefinitionType,
    opts?: ResolvePinOptions,
  ): Promise<ResolvedDefinition> {
    // Validate name to prevent path traversal (CWE-22) before filesystem or API use
    if (!RegistryClient.SAFE_NAME_PATTERN.test(name) || name.includes('..')) {
      throw new ConfigurationError(`Invalid definition name: "${name}". Names must be alphanumeric with hyphens, underscores, dots, or forward slashes.`);
    }

    const cacheKey = `${type ?? 'any'}:${name}@${version ?? 'latest'}`;

    // Caller pins are NOT part of the cache key — verification is per-call, the
    // content cache is shared. verifyPins runs on EVERY return path (including
    // cache hits) so a prior unpinned resolve cannot let a later pinned one pass
    // unchecked. Content is cached before verification so a bad pin throws
    // without poisoning the cache for a subsequent correct call.
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit: ${cacheKey}`);
      this.verifyPins(cached, opts);
      return cached;
    }

    // Try local resolution if configured (local takes priority over remote)
    if (this.config.localDefinitions) {
      const local = await this.resolveLocal(name, type, this.config.localDefinitions);
      if (local) {
        this.cache.set(cacheKey, local);
        this.verifyPins(local, opts);
        return local;
      }
    }

    // Resolve from remote registry
    const remote = await this.resolveRemote(name, version, type);
    this.cache.set(cacheKey, remote);
    this.verifyPins(remote, opts);
    return remote;
  }

  /**
   * Caller-pinned integrity verification. Fail-closed: throws IntegrityError on
   * any mismatch or when a prompt pin cannot be satisfied. No-op when no pins
   * are supplied (verification is opt-in).
   */
  private verifyPins(resolved: ResolvedDefinition, opts?: ResolvePinOptions): void {
    if (!opts) return;
    const { expectedHash, expectedPromptHash } = opts;
    const ref = `${resolved.type} "${resolved.name}@${resolved.version}"`;

    if (expectedHash) {
      if (!verifyHash(resolved.yaml ?? '', expectedHash)) {
        throw new IntegrityError(
          `YAML integrity check failed for ${ref}: resolved source does not match the pinned hash. Execution refused.`,
          'yaml', resolved.name, resolved.version, expectedHash, computeHash(resolved.yaml ?? ''),
        );
      }
    }

    if (expectedPromptHash) {
      const prompt = this.verifiablePrompt(resolved);
      if (prompt == null) {
        throw new IntegrityError(
          `No frozen rendered prompt is available to verify for ${ref} ` +
          `(workflow/pipeline, content-gated, local, or schema-stale). A prompt-hash pin ` +
          `cannot be satisfied — omit it for this definition. Execution refused.`,
          'unavailable', resolved.name, resolved.version, expectedPromptHash,
        );
      }
      if (!verifyPromptHash(prompt, expectedPromptHash)) {
        throw new IntegrityError(
          `Prompt integrity check failed for ${ref}: rendered prompt does not match the pinned hash. Execution refused.`,
          'prompt', resolved.name, resolved.version, expectedPromptHash, computePromptHash(prompt),
        );
      }
    }
  }

  /**
   * The executed prompt bytes a prompt-hash pin can be verified against, or null
   * when there is no frozen rendered prompt to pin. Only remote agent/command
   * resolutions that executed the frozen `runtime_md` qualify (signaled by
   * `promptHash` being set). WDL/PDL (YAML is the runtime), local definitions,
   * and live-rerender fallbacks all return null → IntegrityError(kind 'unavailable').
   */
  private verifiablePrompt(resolved: ResolvedDefinition): string | null {
    if (resolved.type !== 'agent' && resolved.type !== 'command') return null;
    if (resolved.promptHash === undefined) return null;
    const runtime = resolved.runtime as { prompt?: unknown };
    return typeof runtime.prompt === 'string' ? runtime.prompt : null;
  }

  /**
   * List available definitions (local + remote, preferring local)
   */
  async list(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    const results: DefinitionSummary[] = [];

    if (this.config.localDefinitions) {
      const local = await this.listLocal(filter, this.config.localDefinitions);
      results.push(...local);
    }

    try {
      // list() always queries the registry (even with local definitions configured)
      // so the result reflects published definitions too. In an offline environment
      // this attempt fails after the SDK's retry/backoff before falling back to the
      // local results below — log it so a ULUOPS_DEBUG run can tell a retry from a hang.
      this.logger.debug('Querying registry for definitions (falls back to local definitions on failure)');
      const remote = await this.listRemote(filter);

      // Merge, preferring local versions
      const seen = new Set(results.map(r => r.name));
      for (const r of remote) {
        if (!seen.has(r.name)) {
          results.push(r);
        }
      }
    } catch (error) {
      this.logger.warn(`Registry unavailable for listing: ${formatErrorMessage(error)}`);
      // Return local results only (if any)
      if (results.length === 0) {
        throw new ConfigurationError(
          'No definitions found. Registry is unreachable and no local definitions are configured. ' +
          'Set localDefinitions in UluOpsClient config or ULUOPS_LOCAL_DEFINITIONS env var.',
        );
      }
    }

    return results;
  }

  /**
   * Clear the definition cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: Local Resolution
  // ─────────────────────────────────────────────────────────────────────────────

  private async resolveLocal(
    name: string,
    type?: DefinitionType,
    baseDir?: string,
  ): Promise<ResolvedDefinition | null> {
    if (!baseDir) return null;

    const allCandidates = [
      { path: path.join(baseDir, `${name}.agent.yaml`), type: 'agent' as DefinitionType },
      { path: path.join(baseDir, `${name}.command.yaml`), type: 'command' as DefinitionType },
      { path: path.join(baseDir, `${name}.workflow.yaml`), type: 'workflow' as DefinitionType },
      { path: path.join(baseDir, `${name}.pipeline.yaml`), type: 'pipeline' as DefinitionType },
      { path: path.join(baseDir, 'agents', `${name}.agent.yaml`), type: 'agent' as DefinitionType },
      { path: path.join(baseDir, 'commands', `${name}.command.yaml`), type: 'command' as DefinitionType },
      { path: path.join(baseDir, 'workflows', `${name}.workflow.yaml`), type: 'workflow' as DefinitionType },
      { path: path.join(baseDir, 'pipelines', `${name}.pipeline.yaml`), type: 'pipeline' as DefinitionType },
    ];

    const candidates = type
      ? allCandidates.filter(c => c.type === type)
      : allCandidates;

    for (const candidate of candidates) {
      let yamlContent: string;
      try {
        yamlContent = await fs.readFile(candidate.path, 'utf-8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // File doesn't exist, try next candidate
        if (code === 'ENOTDIR') continue; // Path component isn't a directory
        throw new ConfigurationError(`Cannot read definition file: ${formatErrorMessage(error)}`);
      }

      let definition: Record<string, unknown>;
      try {
        definition = yaml.parse(yamlContent) as Record<string, unknown>;
      } catch (parseError) {
        throw new ConfigurationError(
          `Failed to parse definition YAML: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }
      this.logger.debug(`Resolved locally: ${name} @ ${candidate.path}`);

      const { runtime, degradations } = await this.renderLocally(yamlContent, definition, candidate.type);

      return {
        type: candidate.type,
        name,
        version: this.extractVersion(definition, candidate.type),
        // Shared normalized hash (matches the registry's scheme) so a caller can
        // pin a local definition's YAML hash and have it verify consistently.
        hash: computeHash(yamlContent),
        yaml: yamlContent,
        definition: this.normalizeLocally(definition),
        runtime,
        domain: this.extractDomain(definition, candidate.type) as ResolvedDefinition['domain'],
        agentType: this.extractAgentType(definition, candidate.type),
        degradations: degradations.length > 0 ? degradations : undefined,
      };
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: Remote Resolution
  // ─────────────────────────────────────────────────────────────────────────────

  private async resolveRemote(
    name: string,
    version?: string,
    type?: DefinitionType,
  ): Promise<ResolvedDefinition> {
    let resolvedType = type;

    // If type not provided, search registry to find it
    if (!resolvedType) {
      const searchResult = await this.sdk.definitions.list({
        search: name,
        limit: 10,
        status: 'published',
      });

      const matches = searchResult.definitions.filter(d => d.name === name);

      if (matches.length === 0) {
        throw new ConfigurationError(
          `Definition "${name}" not found in registry. ` +
          `Verify the name is correct and the definition is published. ` +
          `Call client.list() to see available definitions, or set ULUOPS_API_KEY for registry access.`,
        );
      }

      if (matches.length > 1) {
        const types = matches.map(d => d.type).join(', ');
        throw new ConfigurationError(
          `Multiple definitions named "${name}" found (${types}). ` +
          `Specify type explicitly: resolve("${name}", version, "command")`,
        );
      }

      const match = matches[0];
      if (!match) throw new ConfigurationError(`Definition "${name}" not found in registry. Call client.list() to see available definitions, or set ULUOPS_API_KEY for registry access.`);
      resolvedType = match.type as DefinitionType;
    }

    // Fetch definition with YAML, runtime, and server-side normalization
    let def;
    try {
      def = await this.sdk.definitions.get(resolvedType, name, version, {
        includeYaml: true,
        includeRuntime: true,
        normalize: true,
      });
    } catch (error) {
      // 402 = content-gated by pro-handler; rethrow as typed SubscriptionRequiredError
      if (error instanceof SdkApiError && error.statusCode === 402) {
        const d = error.details ?? {};
        throw new SubscriptionRequiredError(
          error.message || `Definition "${name}" requires a higher subscription tier`,
          (d.requiredTier as string) ?? 'unknown',
          (d.currentTier as string) ?? 'unknown',
          d.definition as { type: string; name: string; displayName?: string } | undefined,
          d.upgradeUrl as string | undefined,
        );
      }
      // 404 = definition not found. The typed resolve path (runAgent/runCommand/
      // runWorkflow) reaches here with a known type and would otherwise surface a
      // terse SDK NotFoundError. Rewrap with the same guidance the type-inference
      // path gives, so a misspelled name has a path forward.
      if (error instanceof SdkApiError && error.statusCode === 404) {
        throw new ConfigurationError(
          `Definition "${name}" (${resolvedType}) not found in registry. ` +
          `Verify the name and type are correct and the definition is published. ` +
          `Call client.list() to see available definitions, or set ULUOPS_API_KEY for registry access.`,
        );
      }
      throw error;
    }

    // Use API-provided normalized output; fall back to client-side if unavailable.
    // Validate the expected top-level section key before casting to catch malformed API responses.
    let definition: ResolvedDefinition['definition'];
    const degradations: string[] = [];
    if (def.normalized && typeof def.normalized === 'object' && resolvedType in (def.normalized as Record<string, unknown>)) {
      definition = def.normalized as unknown as ResolvedDefinition['definition'];
    } else if (def.normalized) {
      this.logger.warn(`Remote normalized definition missing expected section '${resolvedType}'; falling back to local normalization`);
      degradations.push('normalization-fallback');
      definition = def.yaml ? this.normalizeLocally(this.safeParseYaml(def.yaml, name)) : this.emptyDefinition();
      if (!def.yaml) degradations.push('empty-definition');
    } else if (def.yaml) {
      definition = this.normalizeLocally(this.safeParseYaml(def.yaml, name));
    } else {
      degradations.push('empty-definition');
      definition = this.emptyDefinition();
    }

    // Execute the FROZEN, hashed artifact (def.runtimeMd) — not a live re-render —
    // and wire runtime config from the verified YAML. Captures promptHash/
    // translatorVersion so callers can pin the prompt and detect retranslations.
    const { runtime, promptHash, translatorVersion } =
      await this.buildRemoteRuntime(resolvedType, name, def, degradations);

    return {
      type: resolvedType,
      name: def.name,
      version: def.version,
      hash: def.hash,
      ...(promptHash !== undefined && { promptHash }),
      ...(translatorVersion !== undefined && { translatorVersion }),
      yaml: def.yaml ?? '',
      definition,
      runtime,
      domain: (def.domain ?? 'general') as ResolvedDefinition['domain'],
      agentType: (def.agentType ?? undefined) as ResolvedDefinition['agentType'],
      minSubscription: (def.minSubscription as ResolvedDefinition['minSubscription']) ?? undefined,
      riskProfile: (def as unknown as Record<string, unknown>).riskProfile as ResolvedDefinition['riskProfile'] ?? null,
      ...(degradations.length > 0 && { degradations }),
    };
  }

  /**
   * Build the remote runtime from the frozen rendered artifact.
   *
   * Priority: execute `def.runtimeMd` (the published, hashed, safety-scanned
   * prompt that `prompt_hash` certifies). Only when it is null (schema-stale /
   * translation-failed rows) fall back to a live re-render, recording a
   * degradation. For agents, wire `defaults`/`config` from the verified YAML so
   * the executor honors the declared model/temperature/maxTokens (and the YAML
   * pin meaningfully covers config).
   */
  private async buildRemoteRuntime(
    type: DefinitionType,
    name: string,
    def: { version: string; runtimeMd?: string | null; promptHash?: string | null; translatorVersion?: string | null; yaml?: string | null },
    degradations: string[],
  ): Promise<{ runtime: ResolvedDefinition['runtime']; promptHash?: string; translatorVersion?: string }> {
    const translatorVersion = def.translatorVersion ?? undefined;
    let prompt: string;
    let promptHash: string | undefined;

    if (def.runtimeMd != null) {
      prompt = def.runtimeMd;
      promptHash = def.promptHash ?? undefined;
      // Belt-and-suspenders: both values come from the SAME fetch, so this only
      // fires on an internally-inconsistent registry (not benign render drift).
      if (def.promptHash != null && computePromptHash(def.runtimeMd) !== def.promptHash) {
        degradations.push('prompt-hash-inconsistent');
        this.logger.warn(
          `Registry returned runtime_md whose hash does not match the returned prompt_hash for ` +
          `${type} "${name}@${def.version}" — internally inconsistent registry.`,
        );
      }
    } else {
      // No frozen artifact. For a published row this usually means the YAML failed
      // schema validation, so a live re-render will also fail — surface that
      // clearly rather than degrading to an empty prompt (finding N3).
      degradations.push('runtime:live-rerender-fallback');
      let rendered: { markdown: string };
      try {
        rendered = await this.sdk.render.get(type, name, def.version);
      } catch (error) {
        throw new ConfigurationError(
          `Cannot resolve ${type} "${name}@${def.version}": the registry has no frozen rendered ` +
          `prompt (runtime_md) and a live re-render failed (${formatErrorMessage(error)}). The ` +
          `definition is likely schema-stale — retranslate or republish it.`,
        );
      }
      prompt = rendered.markdown;
      // promptHash stays undefined: there is no frozen artifact to pin against.
    }

    if (type === 'agent' && def.yaml) {
      const agent = this.safeParseYaml(def.yaml, name)['agent'] as AgentDefinition['agent'] | undefined;
      // Require interface before building config (buildAgentConfig reads it). A
      // malformed/empty agent section falls through to a prompt-only runtime
      // rather than crashing resolve.
      if (agent?.interface) {
        return {
          runtime: {
            prompt,
            defaults: {
              model: agent.defaults?.model ?? DEFAULT_MODEL_ALIAS,
              timeout: agent.defaults?.timeout ?? 300_000,
              maxTokens: agent.defaults?.max_tokens,
              temperature: agent.defaults?.temperature,
            },
            config: this.buildAgentConfig(agent),
          } as ResolvedDefinition['runtime'],
          promptHash,
          translatorVersion,
        };
      }
    }

    return { runtime: { prompt } as ResolvedDefinition['runtime'], promptHash, translatorVersion };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: YAML Parsing
  // ─────────────────────────────────────────────────────────────────────────────

  private safeParseYaml(yamlContent: string, context: string): Record<string, unknown> {
    try {
      return yaml.parse(yamlContent) as Record<string, unknown>;
    } catch (error) {
      throw new ConfigurationError(
        `Failed to parse YAML for "${context}": ${formatErrorMessage(error)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: Local Rendering
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Normalize a parsed definition for local resolution (CDL/WDL/PDL
   * authoring→runtime transforms), mirroring the server-side normalization the
   * registry API applies on the remote path.
   *
   * This is load-bearing for local/offline resolution: WorkflowExecutor reads
   * `resolved.definition.workflow.orchestration.phases[].commands` directly, so
   * an un-normalized workflow (raw `steps[]`) makes every phase BLOCK. The
   * transforms live in {@link normalizeDefinition} (a faithful port of
   * @uluops/definition-factory, which cannot be a public dependency — see
   * registry/normalize.ts). Agent definitions pass through unchanged.
   */
  private normalizeLocally(parsed: Record<string, unknown>): ResolvedDefinition['definition'] {
    try {
      const { definition } = normalizeDefinition(parsed);
      return definition as unknown as ResolvedDefinition['definition'];
    } catch (error) {
      // Surface normalization/structure failures with core's error taxonomy.
      if (error instanceof DefinitionValidationError) {
        throw new ConfigurationError(error.message);
      }
      throw error;
    }
  }

  /**
   * Placeholder definition for render-only resolution (no YAML available).
   * Returns a partial structure — downstream code MUST use optional chaining.
   */
  private emptyDefinition(): Partial<AgentDefinition> {
    return { agent: {} as Partial<AgentDefinition['agent']> } as Partial<AgentDefinition>;
  }

  /**
   * Build runtime from local YAML definition.
   *
   * Render priority for agents: local definition-factory → registry API → raw YAML.
   * Commands/workflows/pipelines use registry API → raw YAML (CDL/WDL need resolvers).
   * Returns both the runtime and any degradation markers.
   */
  private async renderLocally(
    yamlContent: string,
    definition: Record<string, unknown>,
    type: DefinitionType,
  ): Promise<{ runtime: ResolvedDefinition['runtime']; degradations: string[] }> {
    const degradations: string[] = [];

    if (type === 'agent') {
      const agent = definition['agent'] as AgentDefinition['agent'] | undefined;
      if (!agent) return { runtime: { prompt: '' } as ResolvedDefinition['runtime'], degradations };

      // Render via registry API (definition-factory is server-side only)
      const rendered = await this.tryRenderViaAPI(type, yamlContent, degradations);

      if (!rendered) {
        degradations.push('render:raw-yaml-fallback');
      }

      return {
        runtime: {
          prompt: rendered ?? yamlContent,
          defaults: {
            model: agent.defaults?.model ?? DEFAULT_MODEL_ALIAS,
            timeout: agent.defaults?.timeout ?? 300_000,
            maxTokens: agent.defaults?.max_tokens,
            temperature: agent.defaults?.temperature,
          },
          config: this.buildAgentConfig(agent),
        } as ResolvedDefinition['runtime'],
        degradations,
      };
    }

    if (type === 'command') {
      // CDL needs a resolver for embedded agent refs — use API-first path
      const rendered = await this.tryRenderViaAPI(type, yamlContent, degradations);

      if (!rendered) {
        degradations.push('render:raw-yaml-fallback');
      }

      return {
        runtime: { prompt: rendered ?? yamlContent } as ResolvedDefinition['runtime'],
        degradations,
      };
    }

    // Workflow/pipeline definitions ARE the runtime — the parsed YAML structure
    // is used directly. Validate key structural fields before the type assertion
    // to catch malformed YAMLs that passed castDefinition()'s top-level check.
    // If the required structural key is missing, fall back to prompt-based runtime
    // instead of casting a malformed object that would cause deep runtime errors.
    const section = definition[type] as Record<string, unknown> | undefined;
    const structurallyValid =
      (type === 'workflow' && section && 'orchestration' in section) ||
      (type === 'pipeline' && section && 'stages' in section);

    if (!structurallyValid) {
      const missing = type === 'workflow' ? 'orchestration' : 'stages';
      degradations.push(`runtime:missing-${missing}`);
      this.logger.warn(`${type} definition missing required '${missing}' key; using prompt-based fallback`);
      return {
        runtime: { prompt: yamlContent } as ResolvedDefinition['runtime'],
        degradations,
      };
    }

    return {
      runtime: definition as unknown as ResolvedDefinition['runtime'],
      degradations,
    };
  }

  /**
   * Try to render YAML via the registry API's render.preview() endpoint.
   * Returns the rendered markdown, or null if the API is unavailable.
   */
  private async tryRenderViaAPI(
    type: DefinitionType,
    yamlContent: string,
    degradations: string[],
  ): Promise<string | null> {
    try {
      const result = await this.sdk.render.preview(type as 'agent' | 'command' | 'workflow' | 'pipeline', { yaml: yamlContent, renderProfile: 'uluops-full' });
      this.logger.debug(`Render via API: ${result.markdown.length} chars`);
      return result.markdown;
    } catch (error) {
      // Falling back to raw YAML is non-fatal — the run continues. State that
      // explicitly so a render-auth failure isn't mistaken for a hard error.
      // When no API key is configured (offline/local-only usage) this path is
      // fully expected, so log at debug; otherwise warn. The degradation marker
      // is recorded either way.
      const msg = `Render API unavailable (non-fatal — using raw YAML fallback): ${formatErrorMessage(error)}`;
      if (this.config.apiKey) this.logger.warn(msg);
      else this.logger.debug(msg);
      degradations.push('render:api-unavailable');
      return null;
    }
  }

  /**
   * Build runtime config from ADL v1.6.0 scoring/decisions sections.
   */
  private buildAgentConfig(agent: AgentDefinition['agent']): Record<string, unknown> {
    if (agent.interface.agentType === 'validator' && agent.scoring) {
      const passThreshold = agent.decisions?.thresholds?.find(t => t.decision === 'positive');
      return {
        maxScore: agent.scoring.maxScore,
        threshold: passThreshold?.min_score ?? DEFAULT_PASS_THRESHOLD,
        categories: agent.scoring.categories.map(c => ({
          name: c.name,
          weight: c.weight,
          criteria: c.criteria.map(cr => ({
            name: cr.name,
            points: cr.points,
            description: cr.description,
          })),
          description: c.description,
        })),
        outputSchema: agent.output?.format ?? 'markdown',
      };
    }

    if (agent.tasks) {
      return {
        mode: 'execute',
        inputs: agent.tasks.inputs,
        // ADL uses `operations` (AgentTasks.operations: TaskOperation[]) — renamed to
        // `tasks` here for the runtime config (ExecutorRuntime.config.tasks: TaskConfig[]).
        tasks: agent.tasks.operations,
        outputs: agent.tasks.outputs,
        completionCriteria: agent.completion?.criteria ?? [],
        outputSchema: agent.output?.format ?? 'markdown',
      };
    }

    return {};
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: Extraction Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private extractVersion(def: Record<string, unknown>, type: DefinitionType): string {
    const section = def[type] as Record<string, unknown> | undefined;
    const iface = section?.interface as Record<string, unknown> | undefined;
    return (iface?.version as string) ?? 'unknown';
  }

  private extractDomain(def: Record<string, unknown>, type: DefinitionType): string {
    const section = def[type] as Record<string, unknown> | undefined;
    const iface = section?.interface as Record<string, unknown> | undefined;
    return (iface?.domain as string) ?? 'general';
  }

  private extractAgentType(
    def: Record<string, unknown>,
    type: DefinitionType,
  ): ResolvedDefinition['agentType'] {
    if (type !== 'agent') return undefined;
    const agent = def.agent as Record<string, unknown> | undefined;
    const iface = agent?.interface as Record<string, unknown> | undefined;
    return iface?.agentType as ResolvedDefinition['agentType'];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: Listing
  // ─────────────────────────────────────────────────────────────────────────────

  private async listLocal(filter: { type?: DefinitionType; domain?: string } | undefined, baseDir: string): Promise<DefinitionSummary[]> {
    const results: DefinitionSummary[] = [];
    const seen = new Set<string>();

    const typeConfig: Record<DefinitionType, { ext: string; subdir: string }> = {
      agent: { ext: '.agent.yaml', subdir: 'agents' },
      command: { ext: '.command.yaml', subdir: 'commands' },
      workflow: { ext: '.workflow.yaml', subdir: 'workflows' },
      pipeline: { ext: '.pipeline.yaml', subdir: 'pipelines' },
    };

    for (const [type, { ext, subdir }] of Object.entries(typeConfig)) {
      if (filter?.type && filter.type !== type) continue;

      // Scan both baseDir and baseDir/<subdir> (matching resolveLocal candidates)
      const dirsToScan = [baseDir, path.join(baseDir, subdir)];

      for (const dir of dirsToScan) {
        try {
          const files = await fs.readdir(dir);
          for (const file of files) {
            if (!file.endsWith(ext)) continue;
            const name = file.replace(ext, '');
            if (seen.has(`${type}:${name}`)) continue;
            seen.add(`${type}:${name}`);

            const content = await fs.readFile(path.join(dir, file), 'utf-8');
            const def = this.safeParseYaml(content, file);
            const summary = this.extractSummary(def, type as DefinitionType, name);

            if (!filter?.domain || summary.domain === filter.domain) {
              results.push(summary);
            }
          }
        } catch (error) {
          // ENOENT = directory doesn't exist — skip silently (expected for optional subdirs)
          // Other errors (permissions, YAML parse) are logged to aid debugging
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.logger.debug(`listLocal: skipping ${dir}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    return results;
  }

  private async listRemote(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    const result = await this.sdk.definitions.list({
      status: 'published',
      type: filter?.type,
      domain: filter?.domain as Parameters<typeof this.sdk.definitions.list>[0] extends { domain?: infer D } ? D : never,
    });

    return result.definitions.map(d => ({
      type: d.type as DefinitionType,
      name: d.name,
      version: d.version,
      displayName: d.displayName,
      description: d.description,
      domain: d.domain as DefinitionSummary['domain'],
      agentType: (d.agentType ?? undefined) as DefinitionSummary['agentType'],
      status: d.status as DefinitionSummary['status'],
      minSubscription: (d.minSubscription as DefinitionSummary['minSubscription']) ?? undefined,
    }));
  }

  private extractSummary(def: Record<string, unknown>, type: DefinitionType, name: string): DefinitionSummary {
    const section = def[type] as Record<string, unknown> | undefined;
    const iface = (section?.interface ?? {}) as Record<string, unknown>;
    const meta = (section?.meta ?? {}) as Record<string, unknown>;
    return {
      type,
      name: (iface.name as string) ?? name,
      version: (iface.version as string) ?? 'unknown',
      displayName: (iface.displayName as string) ?? name,
      description: (iface.description as string) ?? '',
      domain: ((iface.domain as string) ?? 'general') as DefinitionSummary['domain'],
      subdomain: iface.subdomain as string | undefined,
      agentType: type === 'agent' ? (iface.agentType as DefinitionSummary['agentType']) : undefined,
      status: 'draft',
      tags: iface.tags as string[] | undefined,
      minSubscription: (meta.minSubscription as DefinitionSummary['minSubscription']) ?? undefined,
    };
  }
}
