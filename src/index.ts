// ─── Main Client ──────────────────────────────────────────────────────────────
export { UluOpsClient } from './client/UluOpsClient.js';

// ─── Executors (for advanced usage) ───────────────────────────────────────────
export { AgentExecutor } from './executor/AgentExecutor.js';
export { CommandExecutor } from './executor/CommandExecutor.js';
export { WorkflowExecutor } from './executor/WorkflowExecutor.js';
export { PipelineExecutor } from './executor/PipelineExecutor.js';

// ─── Service Clients ──────────────────────────────────────────────────────────
export { RegistryClient } from './registry/RegistryClient.js';
export { SubmissionClient } from './submission/SubmissionClient.js';

// ─── AI SDK Integration ───────────────────────────────────────────────────────
export { AIProvider } from './ai/AIProvider.js';
export type { AIGenerateResult, AIGenerateOptions } from './ai/AIProvider.js';
export { ModelCatalog } from './ai/ModelCatalog.js';
export type { ResolvedModel, ResolveOptions } from './ai/ModelCatalog.js';
export { ToolAdapter } from './ai/ToolAdapter.js';
export { TokenBudgetTracker } from './ai/TokenBudgetTracker.js';

// ─── Analysis ────────────────────────────────────────────────────────────────
export { AnalysisSummaryExtractor, type AnalysisExtractionResult } from './analysis/index.js';

// ─── Utilities ────────────────────────────────────────────────────────────────
export { OutputExtractor } from './parser/OutputExtractor.js';
export { ToolHandler } from './executor/ToolHandler.js';
export { parseRef } from './utils/parseRef.js';
export { classifyDecision, buildVocabularyMap, resolveDecisionCategory } from './executor/classifyDecision.js';
export type { DecisionCategory, DecisionVocabularyMap } from './executor/classifyDecision.js';
export { deriveCompleteness, resolutionMarkersFromLegacy } from './executor/degradationMarkers.js';
export type { DegradationMarker, DegradationPhase, DegradationSeverity, Completeness } from './types/degradation.js';
export {
  STARTER_DEFINITIONS_DIR,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_WARN_THRESHOLD,
  DEFAULT_GATE_THRESHOLD,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
} from './constants.js';
export {
  UPSTREAM_STAGE_SLICE_CAP,
  UPSTREAM_STAGE_FULL_CAP,
  UPSTREAM_TOTAL_CAP,
  UPSTREAM_MAX_RECOMMENDATIONS,
  UPSTREAM_FULL_HEAD_CHARS,
  UPSTREAM_FULL_TAIL_CHARS,
  UPSTREAM_KILL_SWITCH_ENV,
} from './executor/upstreamContext.js';

// ─── Types: Config ────────────────────────────────────────────────────────────
export type { UluOpsConfig, AIConfig, AIProviderCredentials, ResolvedConfig, ResolvedAIConfig } from './types/config.js';

// ─── Types: Execution ─────────────────────────────────────────────────────────
export type {
  DefinitionType,
  ExecutionType,
  Domain,
  AgentType,
  ExecutionInput,
  UpstreamStageContext,
  ExecutionResult,
  ExecutionMetrics,
  ExecutionOptions,
  Recommendation,
  TrackingError,
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
  StepDefinition,
  StepResult,
  TriggerDefinition,
  TriggerInfo,
  PipelineArtifact,
  PipelineHandle,
} from './types/pipeline.js';

// ─── Types: Registry ──────────────────────────────────────────────────────────
export type {
  ResolvedDefinition,
  DefinitionSummary,
  Reference,
  SubscriptionTier,
} from './types/registry.js';

// ─── Types: Submission ───────────────────────────────────────────────────────
export type {
  RunSubmission,
  RunSubmissionResponse,
  RunHistoryEntry,
  SubmissionQueryOptions,
  FingerprintedRecommendation,
  RegressionInfo,
} from './types/submission.js';

// ─── Types: Parser ────────────────────────────────────────────────────────────
export type {
  ParsedOutput,
  ParsedCategory,
  ParsedFinding,
  ExtractionOptions,
  ExtractionResult,
} from './types/parser.js';

// ─── Types: Tools ─────────────────────────────────────────────────────────────
export type { ToolUseBlock, ToolResult } from './types/tools.js';

// ─── Types: AI ────────────────────────────────────────────────────────────────
export type { UsageMetrics } from './types/ai.js';

// ─── Logger (re-exported from @uluops/sdk-core) ──────────────────────────────
export type { Logger } from '@uluops/sdk-core';

// ─── Security events (re-exported from @uluops/sdk-core) ─────────────────────
// Consumers set UluOpsConfig.onSecurityEvent and type the handler with these.
export type {
  SecurityEvent,
  SecurityEventType,
  SecurityEventHandler,
  AuthType,
  AuthFailureEvent,
  RedirectRejectedEvent,
  TokenRefreshFailedEvent,
  AuthStrategyReplacedEvent,
} from '@uluops/sdk-core';

// ─── Errors: Core SDK ─────────────────────────────────────────────────────────
export {
  UluOpsError,
  UluOpsErrorCodes,
  type UluOpsErrorCode,
  ExecutionError,
  MaxStepsExhaustedError,
  PreflightError,
  ConfigurationError,
  ModelNotFoundError,
  CapabilityError,
  SubmissionError,
  SubmissionErrorCodes,
  type SubmissionErrorCode,
  WorkflowError,
  PipelineError,
  ParseError,
  SubscriptionRequiredError,
  IntegrityError,
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
