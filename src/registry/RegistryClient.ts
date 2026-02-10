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

    if (this.cache.has(cacheKey)) {
      this.logger.debug(`Cache hit: ${cacheKey}`);
      return this.cache.get(cacheKey)!;
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
      this.logger.warn(`Registry unavailable for listing: ${error instanceof Error ? error.message : String(error)}`);
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
      } catch {
        // File doesn't exist, try next candidate
        continue;
      }

      const definition = yaml.parse(yamlContent) as Record<string, unknown>;
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
        throw new Error(`Definition "${name}" not found in registry`);
      }

      if (matches.length > 1) {
        const types = matches.map(d => d.type).join(', ');
        throw new Error(
          `Multiple definitions named "${name}" found (${types}). ` +
          `Specify type explicitly: resolve("${name}", version, "command")`,
        );
      }

      resolvedType = matches[0]!.type as DefinitionType;
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
      definition: (def.yaml ? yaml.parse(def.yaml) : {}) as ResolvedDefinition['definition'],
      runtime: { prompt: rendered.markdown } as ResolvedDefinition['runtime'],
      domain: (def.domain ?? 'general') as ResolvedDefinition['domain'],
      agentType: (def.agentType ?? undefined) as ResolvedDefinition['agentType'],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private: Hashing
  // ─────────────────────────────────────────────────────────────────────────────

  private computeHash(yamlContent: string): string {
    const normalized = this.normalizeYaml(yamlContent);
    return 'sha256:' + crypto.createHash('sha256').update(normalized).digest('hex');
  }

  private normalizeYaml(yamlContent: string): string {
    const parsed = yaml.parse(yamlContent) as unknown;
    return yaml.stringify(parsed, { sortMapEntries: true });
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
   * Cast parsed YAML to typed definition.
   * Content is validated by file extension; full schema validation is registry-side.
   */
  private castDefinition(parsed: Record<string, unknown>): ResolvedDefinition['definition'] {
    // Record<string, unknown> → unknown → target type (single unsafe boundary, clearly marked)
    return parsed as unknown as ResolvedDefinition['definition'];
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
        },
        config: this.buildAgentConfig(agent),
      } as ResolvedDefinition['runtime'];
    }

    if (type === 'command') {
      return {
        prompt: rendered ?? yamlContent,
      } as ResolvedDefinition['runtime'];
    }

    // Workflows and pipelines: use definition as runtime
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
      this.logger.warn(`Render API unavailable, falling back to raw YAML: ${error instanceof Error ? error.message : String(error)}`);
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

    const extensions: Record<DefinitionType, string> = {
      agent: '.agent.yaml',
      command: '.command.yaml',
      workflow: '.workflow.yaml',
      pipeline: '.pipeline.yaml',
    };

    for (const [type, ext] of Object.entries(extensions)) {
      if (filter?.type && filter.type !== type) continue;

      try {
        const files = await fs.readdir(baseDir);
        for (const file of files) {
          if (file.endsWith(ext)) {
            const content = await fs.readFile(path.join(baseDir, file), 'utf-8');
            const def = yaml.parse(content) as Record<string, unknown>;
            const summary = this.extractSummary(def, type as DefinitionType, file.replace(ext, ''));

            if (!filter?.domain || summary.domain === filter.domain) {
              results.push(summary);
            }
          }
        }
      } catch (error) {
        this.logger.debug(`Local dir scan failed for ${type}: ${error instanceof Error ? error.message : String(error)}`);
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
