import { RegistryClient } from '../registry/RegistryClient.js';
import { ValidationClient } from '../validation/ValidationClient.js';
import { AIProvider } from '../ai/AIProvider.js';
import { ModelCatalog } from '../ai/ModelCatalog.js';
import { AgentExecutor } from '../executor/AgentExecutor.js';
import { CommandExecutor } from '../executor/CommandExecutor.js';
import { WorkflowExecutor } from '../executor/WorkflowExecutor.js';
import { PipelineExecutor } from '../executor/PipelineExecutor.js';
import { createLogger } from '@uluops/sdk-core';
import type { UluOpsConfig, AIConfig, ResolvedConfig, ResolvedAIConfig } from '../types/config.js';
import type { ExecutionInput, ExecutionResult, ExecutionOptions } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { CommandResult } from '../types/command.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineHandle } from '../types/pipeline.js';
import type { DefinitionSummary } from '../types/registry.js';
import type { DefinitionType } from '../types/execution.js';
import { parseRef } from '../utils/parseRef.js';
import type { RunSubmissionResponse, RunHistoryEntry, ValidationQueryOptions } from '../types/validation.js';

/** Default request timeout: 5 minutes. Allows for model cold-start + multi-step tool loops in agent execution. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Unified UluOps SDK client.
 *
 * Wires together registry, validation, AI, and execution layers.
 * Provides type-safe methods for each execution type plus auto-routing.
 *
 * Execution methods:
 * - `runAgent(name, target, options?)` — Direct agent execution with call-time options
 * - `runCommand(name, input)` — Command execution with saved configuration
 * - `runWorkflow(name, input)` — Workflow execution
 * - `run(name, input)` — Auto-detect type and route
 * - `startPipeline(name, input)` — Async pipeline execution
 */
export class UluOpsClient {
  private registry: RegistryClient;
  private validation: ValidationClient;
  private agentExecutor: AgentExecutor;
  private commandExecutor: CommandExecutor;
  private workflowExecutor: WorkflowExecutor;
  private pipelineExecutor: PipelineExecutor;
  private config: ResolvedConfig;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: UluOpsConfig) {
    this.config = this.resolveConfig(config);

    this.logger = createLogger('[core]', this.config.debug);
    const logger = this.logger;

    this.registry = new RegistryClient(this.config, logger);
    this.validation = new ValidationClient(this.config);

    // ModelCatalog resolves aliases via registry (no auto-sync; cache cleared via refresh())
    const modelCatalog = new ModelCatalog(this.registry.registrySdk);
    const aiProvider = new AIProvider(this.config, modelCatalog, logger);

    this.agentExecutor = new AgentExecutor(this.config, aiProvider, logger);
    this.commandExecutor = new CommandExecutor(this.agentExecutor, this.registry);
    this.workflowExecutor = new WorkflowExecutor(this.commandExecutor, this.registry);
    this.pipelineExecutor = new PipelineExecutor(
      this.workflowExecutor,
      this.commandExecutor,
      this.registry,
    );
  }

  // ─── Primary Execution Methods ──────────────────────────────────────────

  /**
   * Direct agent execution with call-time options.
   *
   * Use for interactive/ad-hoc validation, experimentation, and development.
   * For reproducible CI runs, use `runCommand()` instead.
   */
  async runAgent(
    name: string,
    target: string,
    options?: ExecutionOptions,
  ): Promise<AgentResult> {
    const resolved = await this.resolveByRef(name, 'agent');

    if (resolved.type !== 'agent') {
      throw new Error(`${name} is not an agent (type: ${resolved.type}). Use runCommand() instead.`);
    }

    const result = await this.agentExecutor.execute(resolved, { target }, options);
    await this.trackIfEnabled(result, resolved.name, 'agent', options);
    return result;
  }

  /**
   * Execute a saved command configuration.
   *
   * Uses model, thresholds, and aggregation from the command definition.
   * Ideal for CI/CD pipelines and team-standardized validation.
   */
  async runCommand(name: string, input: ExecutionInput): Promise<CommandResult> {
    const resolved = await this.resolveByRef(name, 'command');

    if (resolved.type !== 'command') {
      throw new Error(`${name} is not a command (type: ${resolved.type}). Use runAgent() for agents or runWorkflow() for workflows.`);
    }

    const result = await this.commandExecutor.execute(resolved, input);
    await this.trackIfEnabled(result, resolved.name, 'command');
    return result;
  }

  /**
   * Execute a workflow with multi-phase orchestration.
   */
  async runWorkflow(name: string, input: ExecutionInput): Promise<WorkflowResult> {
    const resolved = await this.resolveByRef(name, 'workflow');

    if (resolved.type !== 'workflow') {
      throw new Error(`${name} is not a workflow (type: ${resolved.type}). Use runAgent() for agents or runCommand() for commands.`);
    }

    const result = await this.workflowExecutor.execute(resolved, input);
    await this.trackIfEnabled(result, resolved.name, 'workflow');
    return result;
  }

  /**
   * Universal execution — auto-routes based on definition type.
   *
   * Resolves the definition name and delegates to the appropriate executor.
   * Agents are directly executable (wrapped as ExecutionResult).
   */
  async run(name: string, input: ExecutionInput): Promise<ExecutionResult | AgentResult> {
    const resolved = await this.resolveByRef(name);
    let result: ExecutionResult | AgentResult;

    switch (resolved.type) {
      case 'agent':
        result = await this.agentExecutor.execute(resolved, input);
        break;
      case 'command':
        result = await this.commandExecutor.execute(resolved, input);
        break;
      case 'workflow':
        result = await this.workflowExecutor.execute(resolved, input);
        break;
      case 'pipeline':
        result = await this.pipelineExecutor.execute(resolved, input);
        break;
      default:
        throw new Error(`Unknown definition type: ${resolved.type}`);
    }

    await this.trackIfEnabled(result, resolved.name, resolved.type);
    return result;
  }

  /**
   * Start an async pipeline execution.
   * Returns a PipelineHandle for monitoring and control.
   */
  async startPipeline(name: string, input: ExecutionInput): Promise<PipelineHandle> {
    const resolved = await this.resolveByRef(name, 'pipeline');

    if (resolved.type !== 'pipeline') {
      throw new Error(`${name} is not a pipeline (type: ${resolved.type}). Use runWorkflow() for workflows or runCommand() for commands.`);
    }

    return this.pipelineExecutor.start(resolved, input);
  }

  // ─── Convenience Methods ────────────────────────────────────────────────

  /** Run the built-in `validate` command against a target. */
  async validate(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('validate', { target, options });
  }

  /** Run the built-in `security` command against a target. */
  async security(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('security', { target, options });
  }

  /** Run the built-in `optimize` command against a target. */
  async optimize(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('optimize', { target, options });
  }

  /** Run the built-in `ship` workflow against a target. */
  async ship(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('ship', { target, options });
  }

  /** Run the built-in `post-implementation` workflow against a target. */
  async postImplementation(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('post-implementation', { target, options });
  }

  // ─── Discovery ──────────────────────────────────────────────────────────

  /** List available definitions from local files and registry. */
  async list(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    return this.registry.list(filter);
  }

  /** Inspect a definition's metadata and interface. */
  async describe(name: string): Promise<{
    type: DefinitionType;
    name: string;
    version: string;
    hash: string;
    interface: Record<string, unknown>;
  }> {
    const resolved = await this.registry.resolve(name);
    return {
      type: resolved.type,
      name: resolved.name,
      version: resolved.version,
      hash: resolved.hash,
      interface: this.extractInterface(resolved.definition),
    };
  }

  // ─── Validation Service Delegation ──────────────────────────────────────

  /** Query validation run history for a project. */
  async getHistory(
    project: string,
    options?: ValidationQueryOptions,
  ): Promise<RunHistoryEntry[]> {
    return this.validation.getHistory(project, options);
  }

  /** Get details for a specific validation run by ID. */
  async getRun(runId: string): Promise<RunSubmissionResponse> {
    return this.validation.getRun(runId);
  }

  /** Preview what a submission would do without saving (dry run). */
  async validateRun(
    project: string,
    workflowType: string,
    result: ExecutionResult,
  ): Promise<{ wouldCreate: boolean; wouldUpdate: boolean; wouldRegress: boolean; validationErrors: string[] }> {
    return this.validation.validateRun(project, workflowType, result);
  }

  /** Manually submit execution results to the validation service. */
  async submitResults(
    project: string,
    workflowType: string,
    result: ExecutionResult,
  ): Promise<RunSubmissionResponse> {
    return this.validation.submit({ project, workflowType, result });
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private resolveConfig(config: UluOpsConfig): ResolvedConfig {
    const apiKey = config.apiKey ?? process.env['ULUOPS_API_KEY'] ?? process.env['ULU_API_KEY'];

    if (!apiKey) {
      throw new Error(
        'UluOps API key is required. Provide via config.apiKey, ULUOPS_API_KEY, or ULU_API_KEY environment variable.',
      );
    }

    return {
      apiKey,
      ai: this.resolveAIConfig(config.ai),
      registryUrl: config.registryUrl ?? process.env['ULUOPS_REGISTRY_URL'] ?? 'https://api.uluops.ai/api/v1/registry',
      validationUrl: config.validationUrl ?? process.env['ULUOPS_VALIDATION_URL'] ?? 'https://api.uluops.ai/api/v1/ops',
      dashboardUrl: config.dashboardUrl ?? process.env['ULUOPS_DASHBOARD_URL'] ?? 'https://app.uluops.ai',
      localDefinitions: config.localDefinitions ?? process.env['ULUOPS_LOCAL_DEFINITIONS'],
      trackingEnabled: config.trackingEnabled ?? (process.env['ULUOPS_TRACKING_ENABLED'] !== 'false'),
      hashVerificationEnabled: config.hashVerificationEnabled ?? true,
      timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
      defaultProject: config.defaultProject ?? process.env['ULUOPS_PROJECT'],
      defaultThinkingBudget: config.defaultThinkingBudget ?? 10_000,
      debug: config.debug ?? (process.env['ULUOPS_DEBUG'] === 'true'),
      contextBudget: config.contextBudget ?? 200_000,
    };
  }

  /**
   * Resolve AI config with env var fallbacks.
   *
   * Default: Anthropic provider with ANTHROPIC_API_KEY env var.
   * Env var convention: <PROVIDER>_API_KEY (e.g., ANTHROPIC_API_KEY, OPENAI_API_KEY)
   */
  private resolveAIConfig(ai?: AIConfig): ResolvedAIConfig {
    const providers: Record<string, { apiKey: string }> = {};

    if (ai?.providers) {
      // Use explicitly configured providers with env var fallback
      for (const [name, creds] of Object.entries(ai.providers)) {
        const envKey = `${name.toUpperCase()}_API_KEY`;
        const apiKey = creds.apiKey ?? process.env[envKey];
        if (apiKey) {
          providers[name] = { apiKey };
        }
      }
    } else {
      // Auto-detect: scan env vars for known provider API keys
      const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'cohere'] as const;
      for (const name of KNOWN_PROVIDERS) {
        const envKey = `${name.toUpperCase()}_API_KEY`;
        const apiKey = process.env[envKey];
        if (apiKey) {
          providers[name] = { apiKey };
        }
      }
    }

    return {
      providers,
      defaultProvider: ai?.defaultProvider ?? 'anthropic',
      modelOverride: ai?.modelOverride,
    };
  }

  private async resolveByRef(name: string, type?: DefinitionType) {
    const [refName, refVersion] = parseRef(name);
    return type
      ? this.registry.resolve(refName, refVersion, type)
      : this.registry.resolve(refName, refVersion);
  }

  private async trackIfEnabled(
    result: ExecutionResult | AgentResult,
    resolvedName: string,
    workflowType: string,
    options?: { trackResults?: boolean; project?: string },
  ): Promise<void> {
    const shouldTrack = options?.trackResults ?? this.config.trackingEnabled;
    if (!shouldTrack) return;

    try {
      const response = await this.validation.submit({
        project: options?.project ?? this.config.defaultProject ?? resolvedName,
        workflowType,
        result: result as ExecutionResult,
      });
      // Attach dashboard URL to result for caller convenience
      (result as unknown as Record<string, unknown>).dashboardUrl = response.dashboardUrl;
    } catch (error) {
      this.logger.warn(
        `Tracking submission failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private extractInterface(definition: unknown): Record<string, unknown> {
    const def = definition as Record<string, unknown>;
    for (const key of ['agent', 'command', 'workflow', 'pipeline']) {
      const section = def[key];
      if (section && typeof section === 'object') {
        const iface = (section as Record<string, unknown>)['interface'];
        if (iface && typeof iface === 'object') {
          return iface as Record<string, unknown>;
        }
      }
    }
    return {};
  }
}
