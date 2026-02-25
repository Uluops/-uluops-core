# Changelog

All notable changes to `@uluops/core` will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-25

### Added
- **OpenAI provider support** — `@ai-sdk/openai` bundled as second provider alongside Anthropic
- **Auto-detection of AI providers** — `resolveAIConfig()` scans `OPENAI_API_KEY`, `GOOGLE_API_KEY`, etc. when no explicit `ai.providers` config is given
- **OpenAI shell tool** — `createProviderShellTool()` dispatches to Anthropic `bash_20250124` or OpenAI `shell()` based on resolved model provider
- **OpenAI reasoning support** — auto-sets `reasoningEffort: 'medium'` for reasoning-capable models (o1, o3, o4-mini)
- **OpenAI usage metrics** — maps `cachedPromptTokens` and `reasoningTokens` from OpenAI provider metadata
- **`reasoning_tokens`** field on `UsageMetrics` type for OpenAI reasoning model token tracking
- **`resolveModel()`** on AIProvider (`@internal`) for early provider detection in AgentExecutor

### Changed
- **AIProvider** — refactored from Anthropic-only to multi-provider dispatcher; `buildProviderOptions()` dispatches to `buildAnthropicOptions()` / `buildOpenAIOptions()`
- **AIProvider** — `buildSystemMessage()` returns plain string for non-Anthropic providers (OpenAI caching is automatic for prompts ≥1024 tokens)
- **AgentExecutor** — shell tool setup uses early model resolution to select correct provider tool
- **UluOpsClient** — `resolveAIConfig()` auto-detects providers via `KNOWN_PROVIDERS` env var scan instead of defaulting to Anthropic-only

### Removed
- **`createBashTool()`** — replaced by `createProviderShellTool(provider, targetDir, timeoutMs)`

## [0.1.0] - 2026-02-09

### Added
- Initial SDK implementation
- 4-layer execution hierarchy: Agent > Command > Workflow > Pipeline
- AI SDK v6 integration via AIProvider (replaces direct Anthropic SDK usage)
- ToolHandler with filesystem sandboxing (read_file, list_files, search_content)
- OutputExtractor with 3-strategy JSON extraction
- RegistryClient for local + remote definition resolution with hash verification
- ValidationClient for core execution submission (submit, validateRun, getHistory, getRun)
- PipelineHandle for async pipeline monitoring
- AgentResult discriminated union types (ValidatorAgentResult, ExecutorAgentResult)
- Safe condition evaluator for PipelineExecutor (replaces `new Function()`)
- Reuses `@uluops/sdk-core` HttpClient for RegistryClient and ValidationClient HTTP infrastructure

### Changed (Pre-implementation Architecture Review)
- **`@uluops/sdk-core` integration**: RegistryClient and ValidationClient now use HttpClient (retry, rate limits, error mapping handled automatically)
- **Error hierarchy aligned**: HTTP errors (RateLimitError, UnauthorizedError, etc.) re-exported from `@uluops/sdk-core/errors`; removed duplicate RegistryError, ClaudeAPIError, AuthenticationError, ServerError
- **ValidationClient scope reduced**: From ~25 methods to 4 core execution methods (submit, validateRun, getHistory, getRun). Analytics, issue management, and taxonomy operations available via `@uluops/ops-sdk`
- **AIProvider simplified**: Anthropic-only for v0.1.0 (removed OpenAI/Google from MODEL_MAP). Additional providers can be added in future versions
- **Config simplified**: Removed `provider` and `providerApiKey` fields (Anthropic-only)
- **CommandExecutor type safety**: Replaced `any` casts with proper discriminated union narrowing via type predicates

### Fixed (Spec v0.9.0)
- Duplicate `detectEnvironment()` in ValidationClient (kept CI-detection version)
- `submit()` call signature mismatch in UluOpsClient (now uses RunSubmission objects)
- Missing `runningPipelines` Map in PipelineExecutor
- `score` made optional in ExecutionResult (not all executions produce scores)
- Model IDs updated to Claude 4.5/4.6 (haiku-4-5, sonnet-4-5, opus-4-6)
- `new Function()` eval replaced with safe regex-based condition parser
- `transformToAPIRequest` builds validators from ExecutionResult (not non-existent `result.validators`)
- Operator precedence in `parseIssues` and `parseArtifacts` (`??` with `as` chains)
- `AgentResult` discriminated union types added to `types/agent.ts`
- `PipelineHandle` class implementation added to `client/PipelineHandle.ts`
