// ─── Main Client ──────────────────────────────────────────────────────────────
export { UluOpsClient } from './client/UluOpsClient.js';

// ─── Executors (for advanced usage) ───────────────────────────────────────────
export { AgentExecutor } from './executor/AgentExecutor.js';
export { CommandExecutor } from './executor/CommandExecutor.js';
export { WorkflowExecutor } from './executor/WorkflowExecutor.js';
export { PipelineExecutor } from './executor/PipelineExecutor.js';

// ─── Service Clients ──────────────────────────────────────────────────────────
export { RegistryClient } from './registry/RegistryClient.js';
export { ValidationClient } from './validation/ValidationClient.js';

// ─── AI SDK Integration ───────────────────────────────────────────────────────
export { AIProvider } from './ai/AIProvider.js';
export type { AIGenerateResult, AIGenerateOptions } from './ai/AIProvider.js';
export { ModelCatalog } from './ai/ModelCatalog.js';
export type { ResolvedModel, ResolveOptions } from './ai/ModelCatalog.js';
export { ToolAdapter } from './ai/ToolAdapter.js';
export { TokenBudgetTracker } from './ai/TokenBudgetTracker.js';

// ─── Utilities ────────────────────────────────────────────────────────────────
export { OutputExtractor } from './parser/OutputExtractor.js';
export { ToolHandler } from './executor/ToolHandler.js';
export { parseRef } from './utils/parseRef.js';
export { STARTER_DEFINITIONS_DIR } from './constants.js';

// ─── Types: Config ────────────────────────────────────────────────────────────
export type { UluOpsConfig, AIConfig, AIProviderCredentials, ResolvedConfig, ResolvedAIConfig } from './types/config.js';

// ─── Types: Execution ─────────────────────────────────────────────────────────
export type {
  DefinitionType,
  ExecutionType,
  Domain,
  AgentType,
  ExecutionInput,
  ExecutionResult,
  ExecutionMetrics,
  ExecutionOptions,
  ResolvedExecutionContext,
  Recommendation,
} from './types/execution.js';

// ─── Types: Agent ─────────────────────────────────────────────────────────────
export type {
  AgentDefinition,
  AgentInterface,
  AgentDefaults,
  AgentMission,
  AgentScoring,
  AgentDecisions,
  AgentTasks,
  AgentCompletion,
  AgentOutput,
  ScoringCategory,
  ScoringCriterion,
  AgentResult,
  ValidatorAgentResult,
  ExecutorAgentResult,
} from './types/agent.js';

// ─── Types: Command ───────────────────────────────────────────────────────────
export type {
  CommandDefinition,
  CommandResult,
  CommandMetrics,
  CategoryResult,
  Finding,
  Issue,
  ArtifactResult,
  PreflightCheck,
  PostflightAction,
} from './types/command.js';

// ─── Types: Workflow ──────────────────────────────────────────────────────────
export type {
  WorkflowDefinition,
  WorkflowResult,
  WorkflowMetrics,
  PhaseDefinition,
  PhaseResult,
  CommandMetricsSummary,
} from './types/workflow.js';

// ─── Types: Pipeline ──────────────────────────────────────────────────────────
export type {
  PipelineDefinition,
  PipelineResult,
  PipelineMetrics,
  StageDefinition,
  StageResult,
  TriggerDefinition,
  TriggerInfo,
  PipelineArtifact,
  PipelineHandle,
  PipelineState,
} from './types/pipeline.js';

// ─── Types: Registry ──────────────────────────────────────────────────────────
export type {
  ResolvedDefinition,
  DefinitionSummary,
  Reference,
} from './types/registry.js';

// ─── Types: Validation ────────────────────────────────────────────────────────
export type {
  RunSubmission,
  RunSubmissionResponse,
  RunHistoryEntry,
  ValidationQueryOptions,
  FingerprintedRecommendation,
  RegressionInfo,
} from './types/validation.js';

// ─── Types: Parser ────────────────────────────────────────────────────────────
export type {
  ParsedOutput,
  ParsedCategory,
  ParsedFinding,
  ExtractionOptions,
  ExtractionResult,
} from './types/parser.js';

// ─── Types: Tools ─────────────────────────────────────────────────────────────
export type { Tool, ToolUseBlock, ToolResult } from './types/tools.js';

// ─── Types: AI ────────────────────────────────────────────────────────────────
export type { UsageMetrics } from './types/ai.js';

// ─── Logger (re-exported from @uluops/sdk-core) ──────────────────────────────
export type { Logger } from '@uluops/sdk-core';

// ─── Errors: Core SDK ─────────────────────────────────────────────────────────
export {
  UluOpsError,
  ExecutionError,
  PreflightError,
  HashVerificationError,
  ConfigurationError,
  ModelNotFoundError,
  CapabilityError,
  ValidationError,
  ValidationErrorCodes,
  type ValidationErrorCode,
  WorkflowError,
  PipelineError,
  ParseError,
} from './errors/index.js';

// ─── Errors: Re-exported from @uluops/sdk-core ───────────────────────────────
export {
  SdkApiError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
} from './errors/index.js';
