import type { ToolSet } from 'ai';
import type { AIProvider, AIGenerateResult } from '../ai/AIProvider.js';
import { ToolHandler, extToLanguage } from './ToolHandler.js';
import { ToolAdapter } from '../ai/ToolAdapter.js';
import { TokenBudgetTracker } from '../ai/TokenBudgetTracker.js';
import { OutputExtractor } from '../parser/OutputExtractor.js';
import { agentOutputSchema } from '../parser/outputSchemas.js';
import { ExecutionError } from '../errors/index.js';
import { classifyDecision, buildVocabularyMap, type DecisionCategory } from './classifyDecision.js';
import type { ResolvedConfig } from '../types/config.js';
import type { ResolvedDefinition, ValidatorRuntime, ExecutorRuntime } from '../types/registry.js';
import type { ExecutionInput, ExecutionOptions, ExecutionMetrics, ResolvedExecutionContext, Recommendation } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { AgentType } from '../types/execution.js';
import type { ParsedOutput, ExtractionResult } from '../types/parser.js';
import type { UsageMetrics } from '../types/ai.js';
import type { Logger } from '@uluops/sdk-core';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_WARN_THRESHOLD, DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, DEFAULT_MODEL_ALIAS } from '../constants.js';

/**
 * Primary executor for single-agent runs.
 *
 * Orchestrates:
 * 1. Prompt rendering from agent definition
 * 2. Tool setup and adaptation for AI SDK
 * 3. LLM generation via AIProvider (tool loop handled by AI SDK)
 * 4. Output parsing and result construction
 *
 * Used directly by `UluOpsClient.runAgent()` and delegated to by
 * `CommandExecutor` for single-agent commands.
 */
export class AgentExecutor {
  private outputExtractor = new OutputExtractor();

  constructor(
    private config: ResolvedConfig,
    private aiProvider: AIProvider,
    private logger: Logger,
  ) {}

  /**
   * Execute an agent against a target directory and return structured results.
   *
   * Orchestrates prompt rendering, tool setup, LLM generation (with tool loop),
   * output parsing, and result construction for a single agent run.
   *
   * @param resolved - Registry-resolved agent definition (must have `type: 'agent'`)
   * @param input - Execution input containing the target directory path and optional config
   * @param options - Runtime overrides for model, thresholds, temperature, timeout, etc.
   * @returns Universal `AgentResult` with score, categories, artifacts, and passthrough decision
   * @throws {ExecutionError} When the resolved definition is not an agent (type mismatch)
   * @throws {ConfigurationError} When AI provider cannot be initialized (missing API key, unknown provider)
   * @throws {ModelNotFoundError} When the model alias cannot be resolved via the model catalog
   * @throws {CapabilityError} When the resolved model lacks required capabilities
   * @throws {ParseError} When the LLM output cannot be extracted as structured JSON
   */
  async execute(
    resolved: ResolvedDefinition,
    input: ExecutionInput,
    options?: ExecutionOptions,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const agentType = resolved.agentType ?? 'validator';

    this.logger.info(`Agent: ${resolved.name} v${resolved.version} (${agentType})`);
    this.logger.debug(`Target: ${input.target}`);

    // 1. Setup execution context and tools
    const context = this.resolveContext(resolved, options);
    this.logger.debug(`Context: model=${context.model}, maxSteps=${context.maxSteps}, temp=${context.temperature}, timeout=${context.timeoutMs}ms`);

    const runtime = this.assertAgentRuntime(resolved);
    const toolAdapter = await this.setupTools(runtime, input, options, context);

    // 2. Execute LLM with tool loop
    const initialMessage = await this.buildInitialMessage(input, toolAdapter.toolHandler);
    const result = await this.aiProvider.generate({
      model: context.model,
      system: runtime.prompt,
      prompt: initialMessage,
      tools: toolAdapter.adapter.getTools(),
      maxTokens: context.maxTokens,
      maxSteps: context.maxSteps,
      timeoutMs: context.timeoutMs,
      temperature: context.temperature,
      contextBudget: this.config.contextBudget,
      budgetTracker: toolAdapter.budgetTracker,
      output: { schema: agentOutputSchema, name: 'AgentResult' },
    });

    // 3. Parse and extract output
    const rawText = result.text ?? '';
    this.logRawOutput(rawText, result.finishReason);
    const { parsed, extraction } = this.parseOutput(result, agentType);
    this.logExtraction(parsed, extraction);

    // 4. Warn on low-confidence extraction — the fallback path may be unreliable
    if (extraction.confidence < 0.7) {
      this.logger.warn(
        `Low extraction confidence (${extraction.confidence}) via ${extraction.method} — decision/score may be defaults, not agent output`,
      );
    }

    // 5. Build result
    const recommendations = this.flattenRecommendations(parsed, resolved.name);
    this.logger.info(`Result: decision=${parsed.decision}, score=${parsed.score ?? 'N/A'}, recommendations=${recommendations.length}`);

    const durationMs = Date.now() - startTime;
    const metrics = this.buildMetrics(result, durationMs);

    // Use extraction-aware decision: if the LLM produced no decision and extraction
    // confidence is low, signal extraction failure rather than masquerading as FAIL.
    const effectiveDecision = parsed.decision
      ?? (extraction.confidence < 0.7 ? 'EXTRACTION_FAILED' : 'FAIL');
    const decisionCategory = this.classifyAgentDecision(resolved, effectiveDecision);

    return this.buildResult(resolved, agentType, context, parsed, effectiveDecision, extraction, recommendations, durationMs, metrics, decisionCategory, rawText);
  }

  /**
   * Setup tool handler, budget tracker, and optional shell tool.
   */
  private async setupTools(
    runtime: ValidatorRuntime | ExecutorRuntime,
    input: ExecutionInput,
    options: ExecutionOptions | undefined,
    context: ResolvedExecutionContext,
  ) {
    const agentTools = runtime.interface?.tools;
    let additionalTools: ToolSet | undefined;
    if (agentTools?.includes('bash') && this.isToolAllowed('bash')) {
      const modelInput = options?.model ?? runtime.defaults?.model ?? this.config.ai.modelOverride ?? DEFAULT_MODEL_ALIAS;
      const resolvedModel = await this.aiProvider.resolveModel(modelInput);
      additionalTools = this.aiProvider.createProviderShellTool(resolvedModel.provider, input.target, context.timeoutMs);
    }

    const toolHandler = new ToolHandler(input.target, this.logger);
    const budgetTracker = new TokenBudgetTracker(this.config.contextBudget);
    const adapter = new ToolAdapter(toolHandler, additionalTools, budgetTracker);

    return { toolHandler, budgetTracker, adapter };
  }

  /**
   * Check if the operator allows a tool. Definitions request tools, operators permit them.
   * When allowedTools is undefined, all tools except 'bash' are allowed (safe default).
   */
  private isToolAllowed(tool: string): boolean {
    const allowed = this.config.allowedTools;
    if (allowed === undefined) {
      // Safe default: bash requires explicit operator opt-in
      return tool !== 'bash';
    }
    return allowed.includes(tool);
  }

  /**
   * Log raw LLM output for cross-model diagnosis.
   */
  private logRawOutput(rawText: string, finishReason: string): void {
    this.logger.debug(`Raw output: ${rawText.length} chars, finishReason=${finishReason}`);
    if (rawText.length > 0 && rawText.length <= 5000) {
      this.logger.debug(`Raw output text:\n${rawText}`);
    } else if (rawText.length > 5000) {
      this.logger.debug(`Raw output (last 2000 chars):\n${rawText.slice(-2000)}`);
    } else {
      this.logger.warn('Empty output — model likely hit maxSteps while still calling tools');
    }
  }

  /**
   * Parse LLM output — prefer structured output, fall back to text extraction.
   */
  private parseOutput(result: AIGenerateResult, agentType: AgentType): { parsed: ParsedOutput; extraction: ExtractionResult } {
    if (result.structuredOutput) {
      const parsed = this.mapStructuredOutput(result.structuredOutput);
      return {
        parsed,
        extraction: { output: parsed, method: 'structured_output', confidence: 1.0, warnings: [] },
      };
    }
    const extraction = this.outputExtractor.extractWithMetadata(result.text, agentType);
    return { parsed: extraction.output, extraction };
  }

  /**
   * Log extraction details and warnings.
   */
  private logExtraction(parsed: ParsedOutput, extraction: ExtractionResult): void {
    this.logger.info(`Output extraction: method=${extraction.method}, confidence=${extraction.confidence}`);
    this.logger.debug(`Parsed output: decision=${parsed.decision}, score=${parsed.score}, hasRawJson=${!!parsed.rawJson}`);
    if (parsed.rawJson) {
      const keys = Object.keys(parsed.rawJson as Record<string, unknown>);
      this.logger.debug(`Raw JSON keys: [${keys.join(', ')}]`);
      this.logger.debug(`Raw JSON sample: ${JSON.stringify(parsed.rawJson).slice(0, 1000)}`);
    }
    if (extraction.warnings.length > 0) {
      this.logger.warn(`Extraction warnings: ${extraction.warnings.join('; ')}`);
    }
  }

  /**
   * Build execution metrics from AI result.
   */
  private buildMetrics(result: AIGenerateResult, durationMs: number): ExecutionMetrics {
    return {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheCreationTokens: result.usage.cache_creation_input_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens,
      thinkingTokens: result.usage.thinking_tokens,
      totalEffectiveTokens: this.calculateEffectiveTokens(result.usage),
      durationMs,
      model: result.model,
      toolCallCount: result.toolCallCount,
    };
  }

  /**
   * Classify decision using agent definition vocabulary.
   */
  private classifyAgentDecision(resolved: ResolvedDefinition, decision: string | undefined): DecisionCategory {
    const vocabularyMap = buildVocabularyMap(resolved.definition as {
      decisions?: { vocabulary?: { positive?: string; negative?: string; conditional?: string | null } };
      completion?: { vocabulary?: { complete?: string; partial?: string; failed?: string } };
    });
    return classifyDecision(decision, vocabularyMap);
  }

  /**
   * Build discriminated agent result based on agent type.
   */
  private buildResult(
    resolved: ResolvedDefinition,
    agentType: AgentType,
    context: ResolvedExecutionContext,
    parsed: ParsedOutput,
    effectiveDecision: string,
    extraction: ExtractionResult,
    recommendations: Recommendation[],
    durationMs: number,
    metrics: ExecutionMetrics,
    decisionCategory: DecisionCategory,
    rawText: string,
  ): AgentResult {
    return {
      type: 'agent',
      agentType,
      name: resolved.name,
      version: resolved.version,
      definitionHash: resolved.hash,
      decision: effectiveDecision,
      decisionCategory,
      score: parsed.score ?? 0,
      maxScore: parsed.maxScore ?? 100,
      threshold: context.thresholds?.pass,
      categories: parsed.categories?.map(c => ({
        name: c.name,
        score: c.score,
        maxScore: c.maxScore,
        findings: c.findings,
      })),
      artifacts: parsed.artifacts,
      recommendations,
      durationMs,
      metrics,
      rawOutput: rawText || undefined,
      extractionMethod: extraction.method,
      extractionConfidence: extraction.confidence,
    };
  }

  /**
   * Merge agent defaults with runtime options.
   * Priority: options > agent defaults > config defaults
   */
  private resolveContext(
    resolved: ResolvedDefinition,
    options?: ExecutionOptions,
  ): ResolvedExecutionContext {
    const runtime = this.assertAgentRuntime(resolved);
    const defaults = runtime?.defaults;

    return {
      model: options?.model ?? defaults?.model ?? this.config.ai.modelOverride ?? DEFAULT_MODEL_ALIAS,
      maxTokens: options?.maxTokens ?? defaults?.maxTokens ?? DEFAULT_MAX_TOKENS,
      timeoutMs: options?.timeoutMs ?? defaults?.timeout ?? this.config.timeout ?? 300_000,
      temperature: options?.temperature ?? defaults?.temperature ?? 0,
      maxSteps: options?.maxSteps ?? DEFAULT_MAX_STEPS,
      thresholds: this.resolveThresholds(
        options?.thresholds,
        defaults && 'thresholds' in defaults ? defaults.thresholds : undefined,
      ),
      trackResults: options?.trackResults ?? this.config.trackingEnabled,
      project: options?.project ?? this.config.defaultProject,
    };
  }

  private assertAgentRuntime(resolved: ResolvedDefinition): ValidatorRuntime | ExecutorRuntime {
    if (resolved.type !== 'agent') {
      throw new ExecutionError(`AgentExecutor received a '${resolved.type}' definition (expected 'agent')`);
    }
    return resolved.runtime as ValidatorRuntime | ExecutorRuntime;
  }

  private resolveThresholds(
    optThresholds?: { pass?: number; warn?: number },
    defThresholds?: { pass?: number; warn?: number },
  ): { pass: number; warn: number } | undefined {
    const pass = optThresholds?.pass ?? defThresholds?.pass;
    const warn = optThresholds?.warn ?? defThresholds?.warn;
    if (pass === undefined && warn === undefined) return undefined;
    return { pass: pass ?? DEFAULT_PASS_THRESHOLD, warn: warn ?? DEFAULT_WARN_THRESHOLD };
  }

  /**
   * Build the initial user message with project structure context
   */
  private async buildInitialMessage(input: ExecutionInput, toolHandler: ToolHandler): Promise<string> {
    const stats = await this.scanProjectStructure(toolHandler);

    return [
      'Analyze the following project:',
      '',
      `Target: ${input.target}`,
      '',
      'Project Structure:',
      stats.tree,
      '',
      'Statistics:',
      `- Files: ${stats.fileCount}`,
      `- Languages: ${stats.languages.join(', ')}`,
      '',
      `Options: ${JSON.stringify(input.options ?? {})}`,
      '',
      'Use the provided tools to read files and analyze the codebase.',
      'Produce your assessment in the required JSON output format.',
    ].join('\n');
  }

  private async scanProjectStructure(toolHandler: ToolHandler): Promise<{
    tree: string;
    fileCount: number;
    languages: string[];
  }> {
    const files = await toolHandler.fulfill({
      id: 'init',
      name: 'list_files',
      input: { path: '.', pattern: '**/*', max_results: 100 },
    });

    const fileList = files.content.split('\n').filter(Boolean);
    const languages = this.detectLanguages(fileList);
    const tree = this.buildTreePreview(fileList, 20);

    // Count may include "... and N more files" line
    const countLine = fileList.find(l => l.startsWith('... and '));
    let fileCount = fileList.length;
    if (countLine) {
      const match = /\.\.\. and (\d+) more files/.exec(countLine);
      if (match) {
        fileCount = fileList.length - 1 + parseInt(match[1]!, 10);
      }
    }

    return { tree, fileCount, languages };
  }

  private detectLanguages(files: string[]): string[] {
    const detected = new Set<string>();
    for (const file of files) {
      // Strip metadata suffix: "file.ts (3.8 KB, 120 lines)" → "file.ts"
      const fileName = file.replace(/\s+\(.*\)$/, '');
      const dotIdx = fileName.lastIndexOf('.');
      if (dotIdx === -1) continue;
      const ext = fileName.substring(dotIdx);
      const lang = extToLanguage(ext);
      if (lang !== 'Unknown') detected.add(lang);
    }

    return Array.from(detected);
  }

  private buildTreePreview(files: string[], maxFiles: number): string {
    const preview = files.slice(0, maxFiles);
    const remaining = files.length - maxFiles;

    let tree = preview.map(f => `  ${f}`).join('\n');
    if (remaining > 0) tree += `\n  ... and ${remaining} more files`;

    return tree;
  }

  /**
   * Map structured output to ParsedOutput.
   * Null values from .nullable() fields are converted to undefined.
   */
  private mapStructuredOutput(output: unknown): ParsedOutput {
    const o = output as {
      decision: string;
      score: number;
      maxScore: number;
      summary: string | null;
      categories: Array<unknown> | null;
      artifacts: Array<unknown> | null;
    };
    return {
      decision: o.decision,
      score: o.score,
      maxScore: o.maxScore,
      summary: o.summary ?? undefined,
      categories: o.categories as ParsedOutput['categories'] ?? undefined,
      artifacts: o.artifacts as ParsedOutput['artifacts'] ?? undefined,
      rawJson: output,
    };
  }

  /**
   * Flatten parsed categories → flat Recommendation array
   */
  private flattenRecommendations(
    parsed: ReturnType<OutputExtractor['extract']>,
    agentName: string,
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    for (const category of parsed.categories ?? []) {
      for (const finding of category.findings ?? []) {
        for (const issue of finding.issues ?? []) {
          recommendations.push({
            agent: agentName,
            title: issue.title,
            priority: issue.priority ?? 'suggested',
            severity: issue.severity ?? 'medium',
            failureCode: issue.failureCode,
            filePath: issue.filePath,
            lineNumber: issue.lineNumber,
            description: issue.description,
          });
        }
      }
    }

    return recommendations;
  }

  private calculateEffectiveTokens(usage: UsageMetrics): number {
    // reasoning_tokens (OpenAI) excluded: already counted within output_tokens by OpenAI's billing.
    // thinking_tokens (Google) included: charged separately from output_tokens by Google.
    return usage.input_tokens + usage.output_tokens
      + (usage.cache_creation_input_tokens ?? 0)
      + (usage.thinking_tokens ?? 0);
  }
}
