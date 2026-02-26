import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { RegistryClient as RegistrySdk } from '@uluops/registry-sdk';
import type { ResolvedConfig } from '../types/config.js';
import type { DefinitionType } from '../types/execution.js';
import type { AgentDefinition } from '../types/agent.js';
import type { ResolvedDefinition, DefinitionSummary } from '../types/registry.js';
import { HashVerificationError } from '../errors/index.js';
import { formatErrorMessage } from '../utils/formatError.js';
import type { Logger } from '@uluops/sdk-core';

/**
 * Definition resolver with local development fallback and hash verification.
 *
 * Delegates remote API calls to @uluops/registry-sdk (which handles retry,
 * rate limiting, error mapping, auth). Local file resolution and hash
 * verification are handled in this class directly.
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
  async resolve(
    name: string,
    version?: string,
    type?: DefinitionType,
  ): Promise<ResolvedDefinition> {
    const cacheKey = `${type ?? 'any'}:${name}@${version ?? 'latest'}`;

    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit: ${cacheKey}`);
      return cached;
    }

    // Try local resolution if configured
    if (this.config.localDefinitions) {
      const local = await this.resolveLocal(name, type);
      if (local) {
        this.cache.set(cacheKey, local);
        return local;
      }
    }

    // Fall back to remote
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
        throw new Error(
          'No definitions found. Registry is unreachable and no local definitions are configured. ' +
          'Use --local-definitions to specify a local directory.',
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
        throw new Error(`Cannot read ${candidate.path}: ${formatErrorMessage(error)}`);
      }

      let definition: Record<string, unknown>;
      try {
        definition = yaml.parse(yamlContent) as Record<string, unknown>;
      } catch (parseError) {
        throw new Error(
          `Failed to parse YAML at ${candidate.path}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }
      const hash = this.computeHash(yamlContent);
      this.logger.debug(`Resolved locally: ${name} @ ${candidate.path}`);

      return {
        type: candidate.type,
        name,
        version: this.extractVersion(definition, candidate.type),
        hash,
        yaml: yamlContent,
        definition: this.castDefinition(definition),
        runtime: await this.renderLocally(yamlContent, definition, candidate.type),
        domain: this.extractDomain(definition, candidate.type) as ResolvedDefinition['domain'],
        agentType: this.extractAgentType(definition, candidate.type),
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
        throw new Error(
          `Definition "${name}" not found in registry. ` +
          `Verify the name is correct and the definition is published.`,
        );
      }

      if (matches.length > 1) {
        const types = matches.map(d => d.type).join(', ');
        throw new Error(
          `Multiple definitions named "${name}" found (${types}). ` +
          `Specify type explicitly: resolve("${name}", version, "command")`,
        );
      }

      const match = matches[0];
      if (!match) throw new Error(`Definition "${name}" not found in registry`);
      resolvedType = match.type as DefinitionType;
    }

    // Fetch definition with YAML and runtime
    const def = await this.sdk.definitions.get(resolvedType, name, version, {
      includeYaml: true,
      includeRuntime: true,
    });

    // Get rendered markdown
    const rendered = await this.sdk.render.get(resolvedType, name, def.version);

    // Verify hash if enabled
    if (this.config.hashVerificationEnabled && def.yaml && def.hash) {
      this.verifyHash(def.yaml, def.hash);
    }

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
  // Private: Hashing
  // ─────────────────────────────────────────────────────────────────────────────

  private safeParseYaml(yamlContent: string, context: string): Record<string, unknown> {
    try {
      return yaml.parse(yamlContent) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to parse YAML for "${context}": ${formatErrorMessage(error)}`,
      );
    }
  }

  private computeHash(yamlContent: string): string {
    return 'sha256:' + crypto.createHash('sha256').update(yamlContent, 'utf8').digest('hex');
  }

  private verifyHash(yamlContent: string, expectedHash: string): void {
    const actualHash = this.computeHash(yamlContent);
    if (actualHash !== expectedHash) {
      throw new HashVerificationError(
        `Hash mismatch: expected ${expectedHash}, got ${actualHash}`,
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
   */
  private castDefinition(parsed: Record<string, unknown>): ResolvedDefinition['definition'] {
    const knownTopKeys = ['agent', 'command', 'workflow', 'pipeline'] as const;
    const topKey = knownTopKeys.find(k => k in parsed);
    if (!topKey) {
      throw new Error(
        `Invalid definition: expected a top-level key of ${knownTopKeys.join(', ')}, ` +
        `found: ${Object.keys(parsed).join(', ')}`,
      );
    }
    const section = parsed[topKey];
    if (typeof section !== 'object' || section === null) {
      throw new Error(`Invalid definition: "${topKey}" must be an object`);
    }
    // Structural guard confirms top-level key is a known definition type
    // with a non-null object value. The intermediate `unknown` cast is
    // unavoidable: Record<string, unknown> lacks the index signature
    // required for direct assignment to the typed definition union.
    return parsed as unknown as ResolvedDefinition['definition'];
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
   * Uses registry-sdk render.preview() to get the proper rendered markdown,
   * falling back to YAML passthrough if the registry API is unavailable.
   */
  private async renderLocally(
    yamlContent: string,
    definition: Record<string, unknown>,
    type: DefinitionType,
  ): Promise<ResolvedDefinition['runtime']> {
    // Try registry API render first (proper template-based rendering)
    const rendered = await this.tryRenderViaAPI(type, yamlContent);

    if (type === 'agent') {
      const agent = definition['agent'] as AgentDefinition['agent'] | undefined;
      if (!agent) return { prompt: '' } as ResolvedDefinition['runtime'];

      return {
        prompt: rendered ?? yamlContent,
        defaults: {
          model: agent.defaults?.model ?? 'sonnet',
          timeout: agent.defaults?.timeout ?? 300_000,
          maxTokens: agent.defaults?.max_tokens,
          temperature: agent.defaults?.temperature,
        },
        config: this.buildAgentConfig(agent),
      } as ResolvedDefinition['runtime'];
    }

    if (type === 'command') {
      return {
        prompt: rendered ?? yamlContent,
      } as ResolvedDefinition['runtime'];
    }

    // Workflow/pipeline definitions ARE the runtime — the parsed YAML structure
    // is used directly. Already validated by castDefinition() in resolveLocal().
    return definition as unknown as ResolvedDefinition['runtime'];
  }

  /**
   * Try to render YAML via the registry API's render.preview() endpoint.
   * Returns the rendered markdown, or null if the API is unavailable.
   */
  private async tryRenderViaAPI(type: DefinitionType, yamlContent: string): Promise<string | null> {
    try {
      const result = await this.sdk.render.preview(type as 'agent' | 'command' | 'workflow' | 'pipeline', { yaml: yamlContent });
      this.logger.debug(`Render via API: ${result.markdown.length} chars`);
      return result.markdown;
    } catch (error) {
      this.logger.warn(`Render API unavailable, falling back to raw YAML: ${formatErrorMessage(error)}`);
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
        threshold: passThreshold?.min_score ?? 75,
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
