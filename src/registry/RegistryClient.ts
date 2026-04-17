import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { RegistryClient as RegistrySdk } from '@uluops/registry-sdk';
import type { ResolvedConfig } from '../types/config.js';
import type { DefinitionType } from '../types/execution.js';
import type { AgentDefinition } from '../types/agent.js';
import type { ResolvedDefinition, DefinitionSummary } from '../types/registry.js';
import { adl } from '@uluops/definition-factory';
import { ConfigurationError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_MODEL_ALIAS } from '../constants.js';
import type { Logger } from '@uluops/sdk-core';

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
      const local = await this.resolveLocal(name, type);
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
      const local = await this.listLocal(filter);
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
  ): Promise<ResolvedDefinition | null> {
    const baseDir = this.config.localDefinitions!;

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
        definition: this.castDefinition(definition),
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
    const def = await this.sdk.definitions.get(resolvedType, name, version, {
      includeYaml: true,
      includeRuntime: true,
    });

    // Get rendered markdown
    const rendered = await this.sdk.render.get(resolvedType, name, def.version);

    return {
      type: resolvedType,
      name: def.name,
      version: def.version,
      hash: def.hash,
      yaml: def.yaml ?? '',
      definition: def.yaml
        ? this.castDefinition(this.safeParseYaml(def.yaml, name))
        : this.emptyDefinition(),
      runtime: { prompt: rendered.markdown } as ResolvedDefinition['runtime'],
      domain: (def.domain ?? 'general') as ResolvedDefinition['domain'],
      agentType: (def.agentType ?? undefined) as ResolvedDefinition['agentType'],
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
   * Cast parsed YAML to typed definition with structural validation.
   * Verifies a known top-level key exists and its value is a non-null object.
   * Full schema validation is registry-side; this prevents totally wrong YAML.
   *
   * DESIGN (2026-04-16): this is intentionally shallow. For local definitions,
   * tryRenderLocalFactory() provides deeper validation via adl.generate() which
   * parses, transforms, and renders the YAML. For remote definitions, the registry
   * API enforces full schema validation at publish time. This guard catches only
   * completely wrong files (e.g., a docker-compose.yaml in the agents/ directory).
   */
  private castDefinition(parsed: Record<string, unknown>): ResolvedDefinition['definition'] {
    const knownTopKeys = ['agent', 'command', 'workflow', 'pipeline'] as const satisfies readonly DefinitionType[];
    const topKey = knownTopKeys.find(k => k in parsed);
    if (!topKey) {
      throw new ConfigurationError(
        `Invalid definition: expected a top-level key of ${knownTopKeys.join(', ')}, ` +
        `found: ${Object.keys(parsed).join(', ')}`,
      );
    }
    const section = parsed[topKey];
    if (typeof section !== 'object' || section === null) {
      throw new ConfigurationError(`Invalid definition: "${topKey}" must be an object`);
    }
    // Structural guard confirms top-level key is a known definition type
    // with a non-null object value. The intermediate `unknown` cast is
    // unavoidable: Record<string, unknown> lacks the index signature
    // required for direct assignment to the typed definition union.

    // Normalize CDL YAML structure → CommandDefinition runtime shape.
    // CDL uses invokes.agent/agents, top-level preflight/postflight, and
    // overrides.threshold — the runtime expects agents[], execution.preflight,
    // execution.postflight, and execution.thresholds.pass.
    if (topKey === 'command') {
      this.normalizeCommandDefinition(section as Record<string, unknown>);
    }

    if (topKey === 'workflow') {
      this.normalizeWorkflowDefinition(section as Record<string, unknown>);
    }

    return parsed as unknown as ResolvedDefinition['definition'];
  }

  /**
   * Normalize CDL YAML structure to match CommandDefinition runtime shape.
   *
   * CDL YAML uses a more ergonomic authoring format that differs from the
   * runtime type contract:
   *   - invokes.agent (string) or invokes.agents (string[]) → agents[]
   *   - top-level preflight → execution.preflight
   *   - top-level postflight → execution.postflight
   *   - overrides.threshold (number) → execution.thresholds.pass
   *
   * Mutates the section in place before it's cast to CommandDefinition.
   */
  private normalizeCommandDefinition(section: Record<string, unknown>): void {
    // invokes.agent / invokes.agents → agents[]
    if (!section['agents']) {
      const invokes = section['invokes'] as Record<string, unknown> | undefined;
      if (invokes) {
        const agent = invokes['agent'];
        const agents = invokes['agents'];
        if (Array.isArray(agents)) {
          section['agents'] = agents;
        } else if (typeof agent === 'string') {
          section['agents'] = [agent];
        }
      }
    }

    // top-level preflight → execution.preflight
    // CDL preflight is { banner?, checks: PreflightCheck[] } — runtime expects PreflightCheck[]
    const execution = (section['execution'] ?? {}) as Record<string, unknown>;
    if (section['preflight'] && !execution['preflight']) {
      const preflight = section['preflight'] as Record<string, unknown>;
      execution['preflight'] = Array.isArray(preflight['checks']) ? preflight['checks'] : preflight;
      section['execution'] = execution;
    }

    // top-level postflight → execution.postflight
    if (section['postflight'] && !execution['postflight']) {
      execution['postflight'] = section['postflight'];
      section['execution'] = execution;
    }

    // overrides.threshold → execution.thresholds.pass
    const overrides = section['overrides'] as Record<string, unknown> | undefined;
    if (overrides?.['threshold'] && !execution['thresholds']) {
      execution['thresholds'] = { pass: overrides['threshold'] };
      section['execution'] = execution;
    }
  }

  /**
   * Normalize WDL YAML structure to match WorkflowDefinition runtime shape.
   *
   * WDL v3 phases use a `steps` array with `{command: "name@version"}` entries,
   * plus `condition` for skip logic and `gate.warn_threshold` for dual thresholds.
   * The runtime PhaseDefinition expects:
   *   - steps[].command → commands[]
   *   - condition → skip_if (negated: condition means "run when true", skip_if means "skip when true")
   *   - gate.on_fail → gate.on_fail (pass-through)
   *   - gate.threshold → gate.threshold (pass-through)
   *
   * Mutates the section in place before it's cast to WorkflowDefinition.
   */
  private normalizeWorkflowDefinition(section: Record<string, unknown>): void {
    const orchestration = section['orchestration'] as Record<string, unknown> | undefined;
    if (!orchestration) return;

    const phases = orchestration['phases'] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(phases)) return;

    for (const phase of phases) {
      // steps[].command → commands[], steps[].agent → agentRefs[]
      if (!phase['commands'] && Array.isArray(phase['steps'])) {
        const steps = phase['steps'] as Array<Record<string, unknown>>;
        phase['commands'] = steps
          .map(s => s['command'] as string)
          .filter(Boolean);
        const agents = steps
          .map(s => s['agent'] as string)
          .filter(Boolean);
        if (agents.length > 0) {
          phase['agentRefs'] = agents;
        }
        delete phase['steps'];
      }

      // condition → skip_if (negated)
      if (phase['condition'] && !phase['skip_if']) {
        phase['skip_if'] = `NOT (${phase['condition']})`;
        delete phase['condition'];
      }

      // Ensure gate.aggregate has a default
      const gate = phase['gate'] as Record<string, unknown> | undefined;
      if (gate && !gate['aggregate']) {
        gate['aggregate'] = 'average';
      }
    }
  }

  /**
   * Placeholder definition for render-only resolution (no YAML available).
   * Downstream code reads definition fields via optional chaining.
   */
  private emptyDefinition(): ResolvedDefinition['definition'] {
    return { agent: {} } as AgentDefinition;
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

      // Try local render first (definition-factory), then API, then raw YAML
      const rendered = this.tryRenderLocalFactory(yamlContent, type, degradations)
        ?? await this.tryRenderViaAPI(type, yamlContent, degradations);

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
   * Try to render YAML locally using @uluops/definition-factory.
   * Synchronous for ADL/PDL. Returns rendered markdown or null.
   */
  private tryRenderLocalFactory(
    yamlContent: string,
    type: DefinitionType,
    degradations: string[],
  ): string | null {
    if (type !== 'agent') return null;

    try {
      const result = adl.generate(yamlContent, { skipValidation: true, renderProfile: 'uluops-full' });
      if (result.success && result.content) {
        this.logger.debug(`Render via local factory: ${result.content.length} chars`);
        return result.content;
      }
      this.logger.warn(`Local factory render failed: ${result.error ?? 'no content'}`);
      degradations.push('render:local-factory-failed');
      return null;
    } catch (error) {
      this.logger.warn(`Local factory render error: ${formatErrorMessage(error)}`);
      degradations.push('render:local-factory-failed');
      return null;
    }
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

  private async listLocal(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    const results: DefinitionSummary[] = [];
    const baseDir = this.config.localDefinitions!;
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
    }));
  }

  private extractSummary(def: Record<string, unknown>, type: DefinitionType, name: string): DefinitionSummary {
    const section = def[type] as Record<string, unknown> | undefined;
    const iface = (section?.interface ?? {}) as Record<string, unknown>;
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
    };
  }
}
