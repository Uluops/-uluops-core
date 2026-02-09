import { RegistryClient } from '../registry/RegistryClient.js';
import { ValidationClient } from '../validation/ValidationClient.js';
import { AIProvider } from '../ai/AIProvider.js';
import { ModelCatalog } from '../ai/ModelCatalog.js';
import { AgentExecutor } from '../executor/AgentExecutor.js';
import { CommandExecutor } from '../executor/CommandExecutor.js';
import { WorkflowExecutor } from '../executor/WorkflowExecutor.js';
import { PipelineExecutor } from '../executor/PipelineExecutor.js';
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

  constructor(config: UluOpsConfig) {
    this.config = this.resolveConfig(config);

    this.registry = new RegistryClient(this.config);
    this.validation = new ValidationClient(this.config);

    // ModelCatalog resolves aliases via registry (no auto-sync; cache cleared via refresh())
    const modelCatalog = new ModelCatalog(this.registry.registrySdk);
    const aiProvider = new AIProvider(this.config, modelCatalog);

    this.agentExecutor = new AgentExecutor(this.config, aiProvider);
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
    const [refName, refVersion] = parseRef(name);
    const resolved = await this.registry.resolve(refName, refVersion, 'agent');

    if (resolved.type !== 'agent') {
      throw new Error(`${name} is not an agent (type: ${resolved.type}). Use runCommand() instead.`);
    }

    const result = await this.agentExecutor.execute(resolved, { target }, options);

    if (options?.trackResults ?? this.config.trackingEnabled) {
      const response = await this.validation.submit({
        project: options?.project ?? this.config.defaultProject ?? resolved.name,
        workflowType: 'agent',
        result,
      });
      result.dashboardUrl = response.dashboardUrl;
    }

    return result;
  }

  /**
   * Execute a saved command configuration.
   *
   * Uses model, thresholds, and aggregation from the command definition.
   * Ideal for CI/CD pipelines and team-standardized validation.
   */
  async runCommand(name: string, input: ExecutionInput): Promise<CommandResult> {
    const [refName, refVersion] = parseRef(name);
    const resolved = await this.registry.resolve(refName, refVersion, 'command');

    if (resolved.type !== 'command') {
      throw new Error(`${name} is not a command (type: ${resolved.type}). Use runAgent() for agents or runWorkflow() for workflows.`);
    }

    const result = await this.commandExecutor.execute(resolved, input);

    if (this.config.trackingEnabled) {
      const response = await this.validation.submit({
        project: this.config.defaultProject ?? resolved.name,
        workflowType: 'command',
        result,
      });
      result.dashboardUrl = response.dashboardUrl;
    }

    return result;
  }

  /**
   * Execute a workflow with multi-phase orchestration.
   */
  async runWorkflow(name: string, input: ExecutionInput): Promise<WorkflowResult> {
    const [refName, refVersion] = parseRef(name);
    const resolved = await this.registry.resolve(refName, refVersion, 'workflow');

    if (resolved.type !== 'workflow') {
      throw new Error(`${name} is not a workflow (type: ${resolved.type}). Use runAgent() for agents or runCommand() for commands.`);
    }

    const result = await this.workflowExecutor.execute(resolved, input);

    if (this.config.trackingEnabled) {
      const response = await this.validation.submit({
        project: this.config.defaultProject ?? resolved.name,
        workflowType: 'workflow',
        result,
      });
      result.dashboardUrl = response.dashboardUrl;
    }

    return result;
  }

  /**
   * Universal execution — auto-routes based on definition type.
   *
   * Resolves the definition name and delegates to the appropriate executor.
   * Agents are directly executable (wrapped as ExecutionResult).
   */
  async run(name: string, input: ExecutionInput): Promise<ExecutionResult | AgentResult> {
    const [refName, refVersion] = parseRef(name);
    const resolved = await this.registry.resolve(refName, refVersion);
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

    if (this.config.trackingEnabled) {
      const response = await this.validation.submit({
        project: this.config.defaultProject ?? resolved.name,
        workflowType: resolved.type,
        result,
      });
      result.dashboardUrl = response.dashboardUrl;
    }

    return result;
  }

  /**
   * Start an async pipeline execution.
   * Returns a PipelineHandle for monitoring and control.
   */
  async startPipeline(name: string, input: ExecutionInput): Promise<PipelineHandle> {
    const [refName, refVersion] = parseRef(name);
    const resolved = await this.registry.resolve(refName, refVersion, 'pipeline');

    if (resolved.type !== 'pipeline') {
      throw new Error(`${name} is not a pipeline (type: ${resolved.type}). Use runWorkflow() for workflows or runCommand() for commands.`);
    }

    return this.pipelineExecutor.start(resolved, input);
  }

  // ─── Convenience Methods ────────────────────────────────────────────────

  async validate(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('validate', { target, options });
  }

  async security(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('security', { target, options });
  }

  async optimize(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('optimize', { target, options });
  }

  async ship(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('ship', { target, options });
  }

  async postImplementation(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('post-implementation', { target, options });
  }

  // ─── Discovery ──────────────────────────────────────────────────────────

  async list(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    return this.registry.list(filter);
  }

  async describe(name: string): Promise<{
    type: DefinitionType;
    name: string;
    version: string;
    hash: string;
    interface: unknown;
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

  async getHistory(
    project: string,
    options?: ValidationQueryOptions,
  ): Promise<RunHistoryEntry[]> {
    return this.validation.getHistory(project, options);
  }

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
      registryUrl: config.registryUrl ?? process.env['ULUOPS_REGISTRY_URL'] ?? 'https://registry.uluops.ai/api',
      validationUrl: config.validationUrl ?? process.env['ULUOPS_VALIDATION_URL'] ?? 'https://ops.uluops.ai/api',
      dashboardUrl: config.dashboardUrl ?? process.env['ULUOPS_DASHBOARD_URL'] ?? 'https://app.uluops.ai',
      localDefinitions: config.localDefinitions ?? process.env['ULUOPS_LOCAL_DEFINITIONS'],
      trackingEnabled: config.trackingEnabled ?? (process.env['ULUOPS_TRACKING_ENABLED'] !== 'false'),
      hashVerificationEnabled: config.hashVerificationEnabled ?? true,
      timeout: config.timeout ?? 300000,
      defaultProject: config.defaultProject ?? process.env['ULUOPS_PROJECT'],
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
      // Default: Anthropic only, from env var
      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      if (anthropicKey) {
        providers.anthropic = { apiKey: anthropicKey };
      }
    }

    return {
      providers,
      defaultProvider: ai?.defaultProvider ?? 'anthropic',
      modelOverride: ai?.modelOverride,
    };
  }

  private extractInterface(definition: unknown): unknown {
    const def = definition as Record<string, Record<string, unknown>>;
    if (def['agent']) return def['agent']['interface'];
    if (def['command']) return def['command']['interface'];
    if (def['workflow']) return def['workflow']['interface'];
    if (def['pipeline']) return def['pipeline']['interface'];
    return {};
  }
}
