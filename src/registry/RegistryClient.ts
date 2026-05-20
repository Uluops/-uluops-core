import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { RegistryClient as RegistrySdk } from '@uluops/registry-sdk';
import { normalizeDefinition, DefinitionValidationError } from '@uluops/registry-sdk/normalization';
import type { ResolvedConfig } from '../types/config.js';
import type { DefinitionType } from '../types/execution.js';
import type { AgentDefinition } from '../types/agent.js';
import type { ResolvedDefinition, DefinitionSummary } from '../types/registry.js';
import { ConfigurationError, SubscriptionRequiredError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_MODEL_ALIAS } from '../constants.js';
import type { Logger } from '@uluops/sdk-core';
import { SdkApiError } from '@uluops/sdk-core/errors';

/**
 * Definition resolver with local development fallback.
 *
 * Delegates remote API calls to @uluops/registry-sdk (which handles retry,
 * rate limiting, error mapping, auth). Local file resolution is handled
 * in this class directly. Hash computation and verification are the
 * responsibility of the registry API server.
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
    });
  }

  /**
   * Resolve a definition by name and optional type.
   * Priority: cache → local files → remote API
   */
  /** Safe definition name pattern — alphanumeric, hyphens, underscores, dots, forward slashes */
  private static readonly SAFE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*$/;

  async resolve(
    name: string,
    version?: string,
    type?: DefinitionType,
  ): Promise<ResolvedDefinition> {
    // Validate name to prevent path traversal (CWE-22) before filesystem or API use
    if (!RegistryClient.SAFE_NAME_PATTERN.test(name) || name.includes('..')) {
      throw new ConfigurationError(`Invalid definition name: "${name}". Names must be alphanumeric with hyphens, underscores, dots, or forward slashes.`);
    }

    const cacheKey = `${type ?? 'any'}:${name}@${version ?? 'latest'}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit: ${cacheKey}`);
      return cached;
    }

    // Try local resolution if configured (local takes priority over remote)
    if (this.config.localDefinitions) {
      const local = await this.resolveLocal(name, type, this.config.localDefinitions);
      if (local) {
        this.cache.set(cacheKey, local);
        return local;
      }
    }

    // Resolve from remote registry
    const remote = await this.resolveRemote(name, version, type);
    this.cache.set(cacheKey, remote);
    return remote;
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
        hash: `sha256:${crypto.createHash('sha256').update(yamlContent).digest('hex')}`,
        yaml: yamlContent,
        definition: this.normalizeOrThrow(definition),
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
          `Verify the name is correct and the definition is published.`,
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
      if (!match) throw new ConfigurationError(`Definition "${name}" not found in registry`);
      resolvedType = match.type as DefinitionType;
    }

    // Fetch definition with YAML and runtime
    let def;
    try {
      def = await this.sdk.definitions.get(resolvedType, name, version, {
        includeYaml: true,
        includeRuntime: true,
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
      throw error;
    }

    // Get rendered markdown
    const rendered = await this.sdk.render.get(resolvedType, name, def.version);

    return {
      type: resolvedType,
      name: def.name,
      version: def.version,
      hash: def.hash,
      yaml: def.yaml ?? '',
      definition: def.yaml
        ? this.normalizeOrThrow(this.safeParseYaml(def.yaml, name))
        : this.emptyDefinition(),
      runtime: { prompt: rendered.markdown } as ResolvedDefinition['runtime'],
      domain: (def.domain ?? 'general') as ResolvedDefinition['domain'],
      agentType: (def.agentType ?? undefined) as ResolvedDefinition['agentType'],
      minSubscription: (def.minSubscription as ResolvedDefinition['minSubscription']) ?? undefined,
    };
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
   * Normalize a parsed definition via @uluops/registry-sdk/normalization,
   * mapping SDK errors to core's ConfigurationError.
   *
   * @see ADR-003 in @uluops/registry-sdk for design rationale.
   */
  private normalizeOrThrow(parsed: Record<string, unknown>): ResolvedDefinition['definition'] {
    try {
      const { definition } = normalizeDefinition(parsed);
      return definition as unknown as ResolvedDefinition['definition'];
    } catch (error) {
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
    // is used directly. Already validated by castDefinition() in resolveLocal().
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
      this.logger.warn(`Render API unavailable: ${formatErrorMessage(error)}`);
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
