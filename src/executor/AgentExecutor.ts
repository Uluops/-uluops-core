import type { ToolSet } from 'ai';
import type { AIProvider } from '../ai/AIProvider.js';
import { ToolHandler, extToLanguage } from './ToolHandler.js';
import { ToolAdapter } from '../ai/ToolAdapter.js';
import { TokenBudgetTracker } from '../ai/TokenBudgetTracker.js';
import { OutputExtractor } from '../parser/OutputExtractor.js';
import {
  validatorOutputSchema,
  executorOutputSchema,
  genericOutputSchema,
} from '../parser/outputSchemas.js';
import { ExecutionError } from '../errors/index.js';
import type { ResolvedConfig } from '../types/config.js';
import type { ResolvedDefinition, ValidatorRuntime, ExecutorRuntime } from '../types/registry.js';
import type { ExecutionInput, ExecutionOptions, ResolvedExecutionContext, Recommendation } from '../types/execution.js';
import type { AgentResult, ValidatorAgentResult, ExecutorAgentResult } from '../types/agent.js';
import type { AgentType } from '../types/execution.js';
import type { ParsedOutput, ExtractionResult } from '../types/parser.js';
import type { UsageMetrics } from '../types/ai.js';
import type { Logger } from '@uluops/sdk-core';
import { DEFAULT_PASS_THRESHOLD, DEFAULT_WARN_THRESHOLD, DEFAULT_MAX_STEPS, DEFAULT_MODEL_ALIAS } from '../constants.js';

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
   * Execute an agent with optional runtime options
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

    // 1. Merge options with agent defaults
    const context = this.resolveContext(resolved, options);
    this.logger.debug(`Context: model=${context.model}, maxSteps=${context.maxSteps}, temp=${context.temperature}, timeout=${context.timeoutMs}ms`);

    // 2. Determine if shell tool should be enabled (opt-in via agent tools list)
    const runtime = this.assertAgentRuntime(resolved);
    const agentTools = runtime.interface?.tools;
    let additionalTools: ToolSet | undefined;
    if (agentTools?.includes('bash')) {
      // Resolve model early to determine the provider for shell tool selection
      const modelInput = options?.model ?? runtime.defaults?.model ?? this.config.ai.modelOverride ?? DEFAULT_MODEL_ALIAS;
      const resolvedModel = await this.aiProvider.resolveModel(modelInput);
      additionalTools = this.aiProvider.createProviderShellTool(resolvedModel.provider, input.target, context.timeoutMs);
    }

    // 3. Setup tool handler, budget tracker, and AI SDK tool adapter
    const toolHandler = new ToolHandler(input.target, this.logger);
    const contextBudget = this.config.contextBudget;
    const budgetTracker = new TokenBudgetTracker(contextBudget);
    const toolAdapter = new ToolAdapter(toolHandler, additionalTools, budgetTracker);

    // 4. Get the system prompt
    const systemPrompt = runtime.prompt;

    // 5. Build initial context message
    const initialMessage = await this.buildInitialMessage(input, toolHandler);

    // 6. Execute via AI SDK (tool loop handled automatically)
    const outputSchema = this.getOutputSchema(agentType);
    const result = await this.aiProvider.generate({
      model: context.model,
      system: systemPrompt,
      prompt: initialMessage,
      tools: toolAdapter.getTools(),
      maxTokens: context.maxTokens,
      maxSteps: context.maxSteps,
      timeoutMs: context.timeoutMs,
      temperature: context.temperature,
      contextBudget,
      budgetTracker,
      output: outputSchema,
    });

    // 6b. Log raw LLM output for cross-model diagnosis
    const rawText = result.text ?? '';
    this.logger.debug(`Raw output: ${rawText.length} chars, finishReason=${result.finishReason}`);
    if (rawText.length > 0 && rawText.length <= 5000) {
      this.logger.debug(`Raw output text:\n${rawText}`);
    } else if (rawText.length > 5000) {
      this.logger.debug(`Raw output (last 2000 chars):\n${rawText.slice(-2000)}`);
    } else {
      this.logger.warn('Empty output — model likely hit maxSteps while still calling tools');
    }

    // 7. Parse output — prefer structured output, fall back to extraction
    let parsed: ParsedOutput;
    let extraction: ExtractionResult;

    if (result.structuredOutput) {
      parsed = this.mapStructuredOutput(result.structuredOutput, agentType);
      extraction = {
        output: parsed,
        method: 'structured_output',
        confidence: 1.0,
        warnings: [],
      };
      this.logger.info('Output extraction: method=structured_output, confidence=1.0');
    } else {
      extraction = this.outputExtractor.extractWithMetadata(result.text, agentType);
      parsed = extraction.output;
      this.logger.info(`Output extraction: method=${extraction.method}, confidence=${extraction.confidence}`);
    }
    this.logger.debug(`Parsed output: decision=${parsed.decision}, score=${parsed.score}, hasRawJson=${!!parsed.rawJson}`);
    if (parsed.rawJson) {
      const keys = Object.keys(parsed.rawJson as Record<string, unknown>);
      this.logger.debug(`Raw JSON keys: [${keys.join(', ')}]`);
      this.logger.debug(`Raw JSON sample: ${JSON.stringify(parsed.rawJson).slice(0, 1000)}`);
    }
    if (extraction.warnings.length > 0) {
      this.logger.warn(`Extraction warnings: ${extraction.warnings.join('; ')}`);
    }

    // 7. Build recommendations
    const recommendations = this.flattenRecommendations(parsed, resolved.name);
    this.logger.info(`Result: decision=${parsed.decision}, score=${parsed.score ?? 'N/A'}, recommendations=${recommendations.length}`);

    // 8. Compute metrics
    const durationMs = Date.now() - startTime;
    const metrics = {
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

    // 9. Return discriminated result
    if (agentType === 'validator') {
      return {
        type: 'agent',
        agentType: 'validator',
        name: resolved.name,
        version: resolved.version,
        definitionHash: resolved.hash,
        decision: (parsed.decision as 'PASS' | 'WARN' | 'FAIL') ?? 'FAIL',
        score: parsed.score ?? 0,
        maxScore: parsed.maxScore ?? 100,
        threshold: context.thresholds?.pass,
        categories: parsed.categories?.map(c => ({
          name: c.name,
          score: c.score,
          maxScore: c.maxPoints,
          findings: c.findings,
        })),
        recommendations,
        durationMs,
        metrics,
        rawOutput: rawText || undefined,
      } satisfies ValidatorAgentResult;
    }

    return {
      type: 'agent',
      agentType: 'executor',
      name: resolved.name,
      version: resolved.version,
      definitionHash: resolved.hash,
      decision: (parsed.decision as 'COMPLETE' | 'PARTIAL' | 'FAILED') ?? 'FAILED',
      artifacts: parsed.artifacts,
      recommendations,
      durationMs,
      metrics,
      rawOutput: rawText || undefined,
    } satisfies ExecutorAgentResult;
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
      maxTokens: options?.maxTokens ?? defaults?.maxTokens ?? 8192,
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
   * Get the appropriate output schema for an agent type.
   */
  private getOutputSchema(agentType: AgentType) {
    switch (agentType) {
      case 'validator':
        return { schema: validatorOutputSchema, name: 'ValidationResult' };
      case 'executor':
        return { schema: executorOutputSchema, name: 'ExecutionResult' };
      case 'analyst':
      case 'generator':
      case 'explorer':
      case 'forecaster':
        return { schema: genericOutputSchema, name: 'AgentResult' };
      default: {
        const _exhaustive: never = agentType;
        throw new Error(`Unknown agent type: ${_exhaustive}`);
      }
    }
  }

  /**
   * Map structured output to ParsedOutput.
   * Null values from .nullable() fields are converted to undefined.
   */
  private mapStructuredOutput(output: unknown, agentType: AgentType): ParsedOutput {
    const base = output as { decision: string; score: number; maxScore: number; summary: string | null };
    const result: ParsedOutput = {
      decision: base.decision,
      score: base.score,
      maxScore: base.maxScore,
      summary: base.summary ?? undefined,
      rawJson: output,
    };

    if (agentType === 'validator') {
      const v = output as { categories: Array<unknown> | null };
      if (v.categories) {
        result.categories = v.categories as ParsedOutput['categories'];
      }
    } else if (agentType === 'executor') {
      const e = output as { artifacts: Array<unknown> | null };
      if (e.artifacts) {
        result.artifacts = e.artifacts as ParsedOutput['artifacts'];
      }
    }

    return result;
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
            priority: issue.priority,
            severity: issue.severity,
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
