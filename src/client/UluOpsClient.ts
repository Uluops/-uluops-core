import * as path from 'node:path';
import { RegistryClient, type ResolvePinOptions } from '../registry/RegistryClient.js';
import { SubmissionClient } from '../submission/SubmissionClient.js';
import { AIProvider } from '../ai/AIProvider.js';
import { ModelCatalog } from '../ai/ModelCatalog.js';
import { AgentExecutor } from '../executor/AgentExecutor.js';
import { CommandExecutor } from '../executor/CommandExecutor.js';
import { WorkflowExecutor } from '../executor/WorkflowExecutor.js';
import { PipelineExecutor } from '../executor/PipelineExecutor.js';
import { createLogger } from '@uluops/sdk-core';
import { ConfigurationError } from '../errors/index.js';
import type { UluOpsConfig, AIConfig, ResolvedConfig, ResolvedAIConfig } from '../types/config.js';
import type { ExecutionInput, ExecutionResult, ExecutionOptions } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { CommandResult } from '../types/command.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineHandle, PipelineResult } from '../types/pipeline.js';
import type { DefinitionSummary, ResolvedDefinition } from '../types/registry.js';
import type { DefinitionType } from '../types/execution.js';
import { parseRef } from '../utils/parseRef.js';
import { DEFAULT_MAX_CONCURRENCY } from '../constants.js';
import type { RunSubmissionResponse, RunHistoryEntry, SubmissionQueryOptions } from '../types/submission.js';

/** Default request timeout: 5 minutes. Allows for model cold-start + multi-step tool loops in agent execution. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Unified UluOps SDK client.
 *
 * Wires together registry, submission, AI, and execution layers.
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
  private submission: SubmissionClient;
  private agentExecutor: AgentExecutor;
  private commandExecutor: CommandExecutor;
  private workflowExecutor: WorkflowExecutor;
  private pipelineExecutor: PipelineExecutor;
  private config: ResolvedConfig;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: UluOpsConfig) {
    this.config = resolveConfig(config);

    this.logger = createLogger('[core]', this.config.debug);
    const logger = this.logger;

    this.registry = new RegistryClient(this.config, logger);
    this.submission = new SubmissionClient(this.config);

    // ModelCatalog resolves aliases via registry (no auto-sync; cache cleared via refresh())
    const modelCatalog = new ModelCatalog(this.registry.registrySdk);
    const aiProvider = new AIProvider(this.config, modelCatalog, logger);

    this.agentExecutor = new AgentExecutor(this.config, aiProvider, logger);
    this.commandExecutor = new CommandExecutor(this.agentExecutor, this.registry, logger);
    this.workflowExecutor = new WorkflowExecutor(this.commandExecutor, this.registry, this.agentExecutor, logger);
    this.pipelineExecutor = new PipelineExecutor(
      this.workflowExecutor,
      this.commandExecutor,
      this.agentExecutor,
      this.registry,
      logger,
      this.config.allowStageSteps,
    );
  }

  // ─── Primary Execution Methods ──────────────────────────────────────────

  /**
   * Direct agent execution with call-time options.
   *
   * Use for interactive/ad-hoc validation, experimentation, and development.
   * For reproducible CI runs, use `runCommand()` instead.
   *
   * @param name - Agent name or `name@version` ref (e.g. `'code-validator'` or `'code-validator@1.2.0'`).
   * @param targetOrInput - Absolute path to the project directory, or a full {@link ExecutionInput} object.
   * @param options - Optional runtime overrides: `model`, `maxTokens`, `thresholds`, `reportMode`,
   *   and caller-pinned integrity hashes (`expectedHash`/`expectedPromptHash`).
   * @returns The {@link AgentResult} — score, decision, category breakdown, `completeness`, and `degradationMarkers`.
   * @throws {ConfigurationError} If the resolved definition is not an agent.
   * @throws {IntegrityError} If integrity pins are supplied and do not match the resolved content.
   * @throws {MaxStepsExhaustedError} If the tool loop exhausts its step ceiling with empty output.
   * @example
   * ```typescript
   * const result = await client.runAgent('code-validator', './src');
   * console.log(`${result.decision} · ${result.score}`);
   *
   * // With overrides and an integrity pin:
   * await client.runAgent('security-analyst', { target: './src' }, {
   *   model: 'opus',
   *   expectedHash: 'sha256-…',
   * });
   * ```
   */
  async runAgent(
    name: string,
    targetOrInput: string | ExecutionInput,
    options?: ExecutionOptions,
  ): Promise<AgentResult> {
    const input: ExecutionInput = typeof targetOrInput === 'string'
      ? { target: targetOrInput }
      : targetOrInput;

    // Forward caller-pinned integrity hashes (if any) into resolve, which verifies
    // fail-closed before the definition is executed. Only pass pins when present
    // so unpinned resolves keep their original (unverified) call path.
    const resolved = await this.resolveByRef(name, 'agent', toPins(options));

    if (resolved.type !== 'agent') {
      throw new ConfigurationError(`${name} is not an agent (type: ${resolved.type}). Use runCommand() instead.`);
    }

    const result = await this.agentExecutor.execute(resolved, input, options);
    await this.trackIfEnabled(result, resolved, resolved.name, options, input.target);
    return result;
  }

  /**
   * Execute a saved command configuration.
   *
   * Uses model, thresholds, and aggregation from the command definition.
   * Pass `overrides.model` to override the definition's default model at runtime.
   * Ideal for CI/CD pipelines and team-standardized validation.
   *
   * @param name - Command name or `name@version` ref.
   * @param input - Execution input ({@link ExecutionInput}); `target` is the absolute project path.
   * @param overrides - Optional runtime overrides; `model` overrides the definition's default model.
   *   `expectedHash`/`expectedPromptHash` pin the resolved definition — verified fail-closed
   *   before anything executes. Pin in CI, especially with `bash` enabled (see README →
   *   Integrity Verification).
   * @returns The aggregated {@link CommandResult} with per-agent scores, decision, and recommendations.
   * @throws {ConfigurationError} If the resolved definition is not a command.
   * @throws {IntegrityError} If a supplied pin does not match the resolved definition.
   * @throws {PreflightError} If a preflight check fails.
   * @throws {ExecutionError} If an underlying agent execution fails.
   */
  async runCommand(
    name: string,
    input: ExecutionInput,
    overrides?: { model?: string; expectedHash?: string; expectedPromptHash?: string },
  ): Promise<CommandResult> {
    const resolved = await this.resolveByRef(name, 'command', toPins(overrides));

    if (resolved.type !== 'command') {
      throw new ConfigurationError(`${name} is not a command (type: ${resolved.type}). Use runAgent() for agents or runWorkflow() for workflows.`);
    }

    const result = await this.commandExecutor.execute(resolved, input, overrides);
    await this.trackIfEnabled(result, resolved, resolved.name, undefined, input.target);
    return result;
  }

  /**
   * Execute a workflow with multi-phase orchestration.
   *
   * Phases run as a DAG with quality gates between them; a gate failure
   * surfaces as a {@link WorkflowError} carrying partial phase results.
   *
   * @param name - Workflow name or `name@version` ref.
   * @param input - Execution input ({@link ExecutionInput}); `target` is the absolute project path.
   * @param options - Optional integrity pins ({@link ResolvePinOptions}), verified fail-closed
   *   at resolve time. Workflows have no rendered prompt — pin `expectedHash` (YAML) only;
   *   `expectedPromptHash` throws `IntegrityError` (`kind: 'unavailable'`).
   * @returns The {@link WorkflowResult} with per-phase results and aggregate metrics.
   * @throws {ConfigurationError} If the resolved definition is not a workflow.
   * @throws {IntegrityError} If a supplied pin does not match the resolved definition.
   * @throws {WorkflowError} If a phase gate fails (`error.context.partialResult` holds completed phases).
   */
  async runWorkflow(name: string, input: ExecutionInput, options?: ResolvePinOptions): Promise<WorkflowResult> {
    const resolved = await this.resolveByRef(name, 'workflow', toPins(options));

    if (resolved.type !== 'workflow') {
      throw new ConfigurationError(`${name} is not a workflow (type: ${resolved.type}). Use runAgent() for agents or runCommand() for commands.`);
    }

    const result = await this.workflowExecutor.execute(resolved, input);
    await this.trackIfEnabled(result, resolved, result.name, undefined, input.target);
    return result;
  }

  /**
   * Execute a pipeline with multi-stage orchestration.
   *
   * Runs synchronously to completion. For long-running pipelines you want to
   * monitor or cancel, use {@link UluOpsClient.startPipeline} instead.
   *
   * @param name - Pipeline name or `name@version` ref.
   * @param input - Execution input ({@link ExecutionInput}); `target` is the absolute project path.
   * @param options - Optional integrity pins ({@link ResolvePinOptions}), verified fail-closed
   *   at resolve time. Pins cover the pipeline YAML only (`expectedHash`) — stage refs are
   *   resolved separately downstream and are NOT individually pinned (per-stage pinning is
   *   lockfile territory). `expectedPromptHash` throws `IntegrityError` (`kind: 'unavailable'`).
   * @returns The {@link PipelineResult} with per-stage results and aggregate metrics.
   * @throws {ConfigurationError} If the resolved definition is not a pipeline.
   * @throws {IntegrityError} If a supplied pin does not match the resolved definition.
   * @throws {PipelineError} If a stage fails (`error.context` holds stage name/index).
   */
  async runPipeline(name: string, input: ExecutionInput, options?: ResolvePinOptions): Promise<PipelineResult> {
    const resolved = await this.resolveByRef(name, 'pipeline', toPins(options));

    if (resolved.type !== 'pipeline') {
      throw new ConfigurationError(`${name} is not a pipeline (type: ${resolved.type}). Use runWorkflow() for workflows or runCommand() for commands.`);
    }

    const result = await this.pipelineExecutor.execute(resolved, input, {
      timeoutMs: this.config.timeout,
      model: this.config.ai.modelOverride,
    });
    await this.trackIfEnabled(result, resolved, result.name, undefined, input.target);
    return result;
  }

  /**
   * Universal execution — auto-routes based on definition type.
   *
   * Resolves the definition name and delegates to the appropriate executor.
   * Use when the definition type is not known at the call site; prefer the
   * typed `run*` methods when it is, for a precise return type.
   *
   * @param name - Definition name or `name@version` ref (any of the four types).
   * @param input - Execution input ({@link ExecutionInput}); `target` is the absolute project path.
   * @param options - Optional integrity pins ({@link ResolvePinOptions}), verified fail-closed
   *   at resolve time. `expectedPromptHash` applies to agent/command resolutions only.
   * @returns An {@link AgentResult} for agents, or an {@link ExecutionResult} for command/workflow/pipeline.
   * @throws {ConfigurationError} If the resolved definition has an unknown type.
   * @throws {IntegrityError} If a supplied pin does not match the resolved definition.
   */
  async run(name: string, input: ExecutionInput, options?: ResolvePinOptions): Promise<ExecutionResult | AgentResult> {
    const resolved = await this.resolveByRef(name, undefined, toPins(options));
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
        result = await this.pipelineExecutor.execute(resolved, input, {
          timeoutMs: this.config.timeout,
          model: this.config.ai.modelOverride,
        });
        break;
      default: {
        const _exhaustive: never = resolved.type;
        throw new ConfigurationError(`Unknown definition type: ${_exhaustive}`);
      }
    }

    await this.trackIfEnabled(result, resolved, resolved.name, undefined, input.target);
    return result;
  }

  /**
   * Start an async pipeline execution.
   *
   * Returns a {@link PipelineHandle} for monitoring and control. Calling
   * `handle.wait()` resolves with the final {@link PipelineResult} and tracks
   * it (when tracking is enabled), mirroring {@link UluOpsClient.runPipeline}.
   *
   * @param name - Pipeline name or `name@version` ref.
   * @param input - Execution input ({@link ExecutionInput}); `target` is the absolute project path.
   * @param options - Optional integrity pins ({@link ResolvePinOptions}); same semantics as
   *   {@link UluOpsClient.runPipeline} — pipeline YAML only, verified before the run starts.
   * @returns A {@link PipelineHandle} exposing `wait()`, status polling, and cancellation.
   * @throws {ConfigurationError} If the resolved definition is not a pipeline.
   * @throws {IntegrityError} If a supplied pin does not match the resolved definition.
   */
  async startPipeline(name: string, input: ExecutionInput, options?: ResolvePinOptions): Promise<PipelineHandle> {
    const resolved = await this.resolveByRef(name, 'pipeline', toPins(options));

    if (resolved.type !== 'pipeline') {
      throw new ConfigurationError(`${name} is not a pipeline (type: ${resolved.type}). Use runWorkflow() for workflows or runCommand() for commands.`);
    }

    const handle = await this.pipelineExecutor.start(resolved, input);

    // Wrap wait() to track results on completion — without this, async pipeline
    // users get no tracking data (only runPipeline's synchronous path tracked).
    const originalWait = handle.wait.bind(handle);
    handle.wait = async (pollIntervalMs?: number): Promise<PipelineResult> => {
      const result = await originalWait(pollIntervalMs);
      await this.trackIfEnabled(result, resolved, result.name, undefined, input.target);
      return result;
    };

    return handle;
  }

  // ─── Convenience Methods ────────────────────────────────────────────────

  /**
   * Run the built-in `validate` command against a target.
   * @param target - Absolute path to the project directory to validate
   * @param options - Optional overrides passed to the command executor
   * @returns Aggregated command result with scores and recommendations
   */
  async validate(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('validate', { target, options });
  }

  /**
   * Run the built-in `security` command against a target.
   * @param target - Absolute path to the project directory to scan
   * @param options - Optional overrides passed to the command executor
   * @returns Aggregated command result with security findings
   */
  async security(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('security', { target, options });
  }

  /**
   * Run the built-in `optimize` command against a target.
   * @param target - Absolute path to the project directory to analyze
   * @param options - Optional overrides passed to the command executor
   * @returns Aggregated command result with optimization recommendations
   */
  async optimize(target: string, options?: Record<string, unknown>): Promise<CommandResult> {
    return this.runCommand('optimize', { target, options });
  }

  /**
   * Run the built-in `ship` workflow against a target.
   * @param target - Absolute path to the project directory to validate for shipping
   * @param options - Optional overrides passed to the workflow executor
   * @returns Workflow result with per-phase outcomes and aggregate decision
   */
  async ship(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('ship', { target, options });
  }

  /**
   * Run the built-in `post-implementation` workflow against a target.
   * @param target - Absolute path to the project directory to validate
   * @param options - Optional overrides passed to the workflow executor
   * @returns Workflow result with iterative validation outcomes
   */
  async postImplementation(target: string, options?: Record<string, unknown>): Promise<WorkflowResult> {
    return this.runWorkflow('post-implementation', { target, options });
  }

  // ─── Discovery ──────────────────────────────────────────────────────────

  /**
   * List available definitions from local files and registry.
   * @param filter - Optional filter by definition type or domain
   * @returns Array of definition summaries matching the filter
   */
  async list(filter?: { type?: DefinitionType; domain?: string }): Promise<DefinitionSummary[]> {
    return this.registry.list(filter);
  }

  /**
   * Inspect a definition's metadata and interface.
   * @param name - Definition name, optionally with version suffix (e.g. "code-validator@1.2.0")
   * @param version - Optional explicit version (overrides any suffix in `name`)
   * @param type - Optional definition type to disambiguate when the same name exists across types
   * @returns Resolved definition metadata including type, version, hash, and interface
   * @example
   * ```typescript
   * // When a name is registered as more than one type, pass `type` to disambiguate:
   * const meta = await client.describe('socrates-explorer', undefined, 'agent');
   * console.log(meta.type, meta.version, meta.hash);
   * ```
   */
  async describe(
    name: string,
    version?: string,
    type?: DefinitionType,
  ): Promise<{
    type: DefinitionType;
    name: string;
    version: string;
    hash: string;
    interface: Record<string, unknown>;
    riskProfile: Record<string, unknown> | null;
  }> {
    const resolved = await this.registry.resolve(name, version, type);
    return {
      type: resolved.type,
      name: resolved.name,
      version: resolved.version,
      hash: resolved.hash,
      interface: this.extractInterface(resolved.definition),
      riskProfile: resolved.riskProfile ?? null,
    };
  }

  // ─── Submission Service Delegation ──────────────────────────────────────

  /**
   * Query run history for a project. Delegates to {@link SubmissionClient.getHistory}.
   *
   * @param project - Target project name.
   * @param options - Optional filters (`workflowType`, `limit`).
   * @returns An array of {@link RunHistoryEntry} (most recent first).
   * @throws {SdkApiError} For transport/auth failures from the submission service.
   */
  async getHistory(
    project: string,
    options?: SubmissionQueryOptions,
  ): Promise<RunHistoryEntry[]> {
    return this.submission.getHistory(project, options);
  }

  /**
   * Get details for a specific run by ID. Delegates to {@link SubmissionClient.getRun}.
   *
   * @param runId - The run's UUID.
   * @returns The {@link RunSubmissionResponse} for the run (correlation counts are zeroed).
   * @throws {NotFoundError} If no run exists with that id.
   * @throws {SdkApiError} For transport/auth failures from the submission service.
   */
  async getRun(runId: string): Promise<RunSubmissionResponse> {
    return this.submission.getRun(runId);
  }

  /**
   * Preview what a submission would do without saving (dry run).
   * Delegates to {@link SubmissionClient.previewSubmission}.
   *
   * @param project - Target project name.
   * @param workflowType - Workflow type (`agent`/`command`/`workflow`/`pipeline`).
   * @param result - The execution result that would be submitted.
   * @returns Whether the submit would create/update/regress, plus any validation errors.
   * @throws {SdkApiError} For transport/auth failures from the submission service.
   */
  async previewSubmission(
    project: string,
    workflowType: string,
    result: ExecutionResult,
  ): Promise<{ wouldCreate: boolean; wouldUpdate: boolean; wouldRegress: boolean; validationErrors: string[] }> {
    return this.submission.previewSubmission(project, workflowType, result);
  }

  /**
   * Manually submit execution results to the submission service.
   * Delegates to {@link SubmissionClient.submit}.
   *
   * @param project - Target project name.
   * @param workflowType - Workflow type (`agent`/`command`/`workflow`/`pipeline`).
   * @param result - The execution result to submit.
   * @returns The {@link RunSubmissionResponse} — run id/number, dashboard URL, correlation counts.
   * @throws {SubmissionError} If the service rejects the submission.
   * @throws {SdkApiError} For transport/auth failures from the submission service.
   */
  async submitResults(
    project: string,
    workflowType: string,
    result: ExecutionResult,
  ): Promise<RunSubmissionResponse> {
    return this.submission.submit({ project, workflowType, result });
  }

  /** Clear the definition resolution cache. Call after registry updates in long-lived processes. */
  clearCache(): void {
    this.registry.clearCache();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  private async resolveByRef(name: string, type?: DefinitionType, opts?: ResolvePinOptions) {
    const [refName, refVersion] = parseRef(name);
    if (opts) {
      return this.registry.resolve(refName, refVersion, type, opts);
    }
    return type
      ? this.registry.resolve(refName, refVersion, type)
      : this.registry.resolve(refName, refVersion);
  }

  private async trackIfEnabled(
    result: ExecutionResult | AgentResult,
    resolved: ResolvedDefinition,
    workflowType: string,
    options?: { trackResults?: boolean; project?: string },
    target?: string,
  ): Promise<void> {
    const shouldTrack = options?.trackResults ?? this.config.trackingEnabled;
    if (!shouldTrack) return;

    if (!this.config.apiKey) {
      this.logger.debug('Tracking skipped: no UluOps API key configured. Set trackingEnabled: false to disable tracking (this is a debug log; it does not appear unless debug logging is on).');
      return;
    }

    try {
      // Project resolution: explicit option > config default > target dir basename > definition name.
      // Without this, running `exec agent dx-validator ./my-project` would create a project
      // named "dx-validator" instead of "my-project".
      const inferredProject = target ? path.basename(path.resolve(target)) : resolved.name;
      const response = await this.submission.submit({
        project: options?.project ?? this.config.defaultProject ?? inferredProject,
        workflowType,
        // Pass original result — WorkflowResult.phases needed for per-agent decomposition
        result,
        resolvedDefinition: resolved,
      });
      // Attach dashboard URL to original result for caller convenience
      result.dashboardUrl = response.dashboardUrl;

      await this.recordExecutions(resolved, result, response.runId);
    } catch (error) {
      result.trackingFailed = true;
      const errMsg = error instanceof Error ? error.message : String(error);
      const errName = error instanceof Error ? error.constructor.name : typeof error;
      // SdkApiError carries statusCode/code/details/requestId; duck-type to stay
      // decoupled from the SDK error class.
      const e = error as { statusCode?: number; code?: string; details?: unknown; requestId?: string };
      const errCode = typeof e.code === 'string' ? e.code : undefined;
      // Surface a typed reason on the result so hosts (e.g. the CLI) can render the
      // failure (e.g. a PROJECT_LIMIT upgrade prompt) instead of it dying in the WARN
      // log below. Non-fatal — the run already succeeded; only recording failed.
      result.trackingError = {
        message: errMsg,
        ...(errCode !== undefined ? { code: errCode } : {}),
        ...(typeof e.statusCode === 'number' ? { statusCode: e.statusCode } : {}),
        ...(typeof e.requestId === 'string' ? { requestId: e.requestId } : {}),
        ...(e.details !== null && typeof e.details === 'object'
          ? { details: e.details as Record<string, unknown> }
          : {}),
      };
      this.logger.warn(`Tracking submission failed (non-fatal): [${errName}${errCode ? `:${errCode}` : ''}] ${errMsg}. Set trackingEnabled: false in config to disable result tracking.`);
      // Log SdkApiError details for diagnosis
      if (error instanceof Error) {
        this.logger.warn(`  statusCode=${e.statusCode} requestId=${e.requestId} details=${JSON.stringify(e.details ?? null)}`);
      }
    }
  }

  /** Record definition-level and per-agent executions in the registry (non-fatal). */
  private async recordExecutions(
    resolved: ResolvedDefinition,
    result: ExecutionResult | AgentResult,
    runId: string,
  ): Promise<void> {
    if (resolved.version === 'unknown') {
      this.logger.debug('Skipping execution recording for unversioned local definition');
      return;
    }

    // Definition-level recording
    try {
      await this.registry.registrySdk.executions.record(
        resolved.type as Parameters<typeof this.registry.registrySdk.executions.record>[0],
        resolved.name,
        resolved.version,
        { source: 'core-sdk', runId },
      );
      this.logger.debug(`Execution recorded for ${resolved.type}/${resolved.name}@${resolved.version}`);
    } catch (execError) {
      this.logger.warn(
        `Execution recording failed (non-fatal): ${execError instanceof Error ? execError.message : String(execError)}`,
      );
    }

    // Per-agent recording for compound definitions
    if (resolved.type !== 'agent') {
      const agents = this.submission.extractAgents(result);
      for (const agent of agents) {
        if (!agent.version || agent.version === 'unknown') continue;
        try {
          await this.registry.registrySdk.executions.record(
            'agent', agent.name, agent.version,
            { source: 'core-sdk', runId },
          );
        } catch (agentExecError) {
          // Non-fatal — agent may not have a published registry definition
          this.logger.debug(
            `Per-agent recording skipped for ${agent.name}: ${agentExecError instanceof Error ? agentExecError.message : String(agentExecError)}`,
          );
        }
      }
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

/**
 * Resolve a partial {@link UluOpsConfig} into a fully-defaulted {@link ResolvedConfig},
 * applying config → environment-variable → built-in-default precedence.
 *
 * Pure: reads only its two arguments and module constants, with no `this` or
 * collaborator dependency. This is the directly-testable unit for config-resolution
 * behavior — assert its return value rather than introspecting what the constructor
 * passes to RegistryClient/SubmissionClient/etc.
 *
 * @param config - Caller-supplied configuration.
 * @param env - Environment source (defaults to `process.env`); pass an explicit
 *   object in tests to avoid mutating/restoring global env.
 * @returns The fully-defaulted resolved configuration.
 * @throws {ConfigurationError} If an API key is required but absent, malformed
 *   (missing `ulr_` prefix), or paired with a non-HTTPS URL while a real key is set.
 */
export function resolveConfig(config: UluOpsConfig, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const apiKey = config.apiKey ?? env['ULUOPS_API_KEY'] ?? env['ULU_API_KEY'];

  // API key is optional when using local definitions with tracking disabled.
  // Remote operations (registry resolve, submission) will fail at call
  // time if no key is available — but local-only usage works without one.
  const needsRemoteAccess = !config.localDefinitions || config.trackingEnabled !== false;
  if (!apiKey && needsRemoteAccess) {
    throw new ConfigurationError(
      'UluOps API key is required for registry and tracking access. ' +
      'Provide via config.apiKey, ULUOPS_API_KEY, or ULU_API_KEY environment variable. ' +
      'Generate a key at https://app.uluops.ai. ' +
      'For offline usage, set localDefinitions and trackingEnabled: false.',
    );
  }

  if (apiKey && !apiKey.startsWith('ulr_')) {
    throw new ConfigurationError(
      `Invalid API key format: keys must begin with "ulr_". ` +
      `Got: "[redacted]". ` +
      `Generate a valid key at https://app.uluops.ai.`,
    );
  }

  const registryUrl = config.registryUrl ?? env['ULUOPS_REGISTRY_URL'] ?? 'https://api.uluops.ai/api/v1/registry';
  const submissionUrl = config.submissionUrl ?? env['ULUOPS_SUBMISSION_URL'] ?? 'https://api.uluops.ai/api/v1';
  const dashboardUrl = config.dashboardUrl ?? env['ULUOPS_DASHBOARD_URL'] ?? 'https://app.uluops.ai';

  // Enforce HTTPS when a real API key is present to prevent credential exfiltration.
  // Allow HTTP for local development (no key, test_ prefix, or localhost/127.0.0.1).
  const isLocalUrl = (url: string) => {
    try { const u = new URL(url); return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; }
    catch { return false; }
  };
  if (apiKey && !apiKey.startsWith('test_')) {
    for (const [label, url] of [['registryUrl', registryUrl], ['submissionUrl', submissionUrl]] as const) {
      if (!url.startsWith('https://') && !isLocalUrl(url)) {
        throw new ConfigurationError(
          `${label} must use HTTPS when an API key is configured (got "${url}"). ` +
          `Use HTTPS to prevent credential exposure, or omit the API key for local-only usage.`,
        );
      }
    }
  }

  return {
    apiKey,
    ai: resolveAIConfig(config.ai, env),
    registryUrl,
    submissionUrl,
    dashboardUrl,
    localDefinitions: config.localDefinitions ?? env['ULUOPS_LOCAL_DEFINITIONS'],
    trackingEnabled: config.trackingEnabled ?? (env['ULUOPS_TRACKING_ENABLED'] !== 'false'),
    // Pass-through: a callback, nothing to default or resolve.
    onSecurityEvent: config.onSecurityEvent,
    timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    defaultProject: config.defaultProject ?? env['ULUOPS_PROJECT'],
    defaultThinkingBudget: config.defaultThinkingBudget ?? 10_000,
    debug: config.debug ?? (env['ULUOPS_DEBUG'] === 'true'),
    contextBudget: config.contextBudget,
    maxRetries: config.maxRetries,
    maxConcurrency: config.maxConcurrency ?? parseMaxConcurrency(env['ULUOPS_MAX_CONCURRENCY']) ?? DEFAULT_MAX_CONCURRENCY,
    allowedTools: config.allowedTools ?? parseAllowedTools(env['ULUOPS_ALLOWED_TOOLS']),
    allowStageSteps: config.allowStageSteps ?? (env['ULUOPS_ALLOW_STAGE_STEPS'] === 'true'),
  };
}

/**
 * Resolve AI config with env var fallbacks.
 *
 * Default: Anthropic provider with ANTHROPIC_API_KEY env var.
 * Env var convention: <PROVIDER>_API_KEY (e.g., ANTHROPIC_API_KEY, OPENAI_API_KEY).
 *
 * @param ai - Caller-supplied AI config (providers, defaultProvider, modelOverride).
 * @param env - Environment source (defaults to `process.env`).
 */
export function resolveAIConfig(ai: AIConfig | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedAIConfig {
  const providers: Record<string, { apiKey: string }> = {};

  if (ai?.providers) {
    // Use explicitly configured providers with env var fallback
    for (const [name, creds] of Object.entries(ai.providers)) {
      const apiKey = creds.apiKey ?? resolveProviderApiKey(name, env);
      if (apiKey) {
        providers[name] = { apiKey };
      }
    }
  } else {
    // Auto-detect: scan env vars for known provider API keys
    const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'cohere'] as const;
    for (const name of KNOWN_PROVIDERS) {
      const apiKey = resolveProviderApiKey(name, env);
      if (apiKey) {
        providers[name] = { apiKey };
      }
    }
  }

  return {
    providers,
    defaultProvider: ai?.defaultProvider ?? 'anthropic',
    modelOverride: ai?.modelOverride,
    additionalProviders: ai?.additionalProviders,
  };
}

/**
 * Parse ULUOPS_MAX_CONCURRENCY env var into a positive integer, or undefined
 * if unset/invalid (caller falls back to DEFAULT_MAX_CONCURRENCY).
 */
function parseMaxConcurrency(envValue?: string): number | undefined {
  if (!envValue) return undefined;
  const n = Number.parseInt(envValue, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse a comma-separated ULUOPS_ALLOWED_TOOLS env var into a trimmed list. */
function parseAllowedTools(envValue?: string): string[] | undefined {
  if (!envValue) return undefined;
  return envValue.split(',').map(t => t.trim()).filter(Boolean);
}

/**
 * Resolve an API key for a provider from environment variables.
 * Checks `<PROVIDER>_API_KEY` first, then provider-specific fallbacks
 * (e.g., `GOOGLE_GENERATIVE_AI_API_KEY` for Google's SDK default).
 */
function resolveProviderApiKey(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envKey = `${name.toUpperCase()}_API_KEY`;
  const apiKey = env[envKey];
  if (apiKey) return apiKey;

  // Google SDK uses GOOGLE_GENERATIVE_AI_API_KEY by default
  if (name === 'google') {
    return env['GOOGLE_GENERATIVE_AI_API_KEY'];
  }

  return undefined;
}

/**
 * Build resolve-time integrity pins from caller options — only when a pin is
 * actually present, so unpinned resolves keep their original (unverified)
 * call path. Shared by every execution entrypoint: pinning must be reachable
 * from the surfaces the README steers CI toward, not just runAgent
 * (tracker 1a49ad7a).
 */
function toPins(options?: { expectedHash?: string; expectedPromptHash?: string }): ResolvePinOptions | undefined {
  return options?.expectedHash || options?.expectedPromptHash
    ? { expectedHash: options.expectedHash, expectedPromptHash: options.expectedPromptHash }
    : undefined;
}
