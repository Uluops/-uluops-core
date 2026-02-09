import type { AIProvider } from '../ai/AIProvider.js';
import { ToolHandler } from './ToolHandler.js';
import { ToolAdapter } from '../ai/ToolAdapter.js';
import { OutputExtractor } from '../parser/OutputExtractor.js';
import type { ResolvedConfig } from '../types/config.js';
import type { ResolvedDefinition, ValidatorRuntime, ExecutorRuntime } from '../types/registry.js';
import type { ExecutionInput, ExecutionOptions, ResolvedExecutionContext, Recommendation } from '../types/execution.js';
import type { AgentResult, ValidatorAgentResult, ExecutorAgentResult } from '../types/agent.js';
import type { UsageMetrics } from '../types/ai.js';

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

    // 1. Merge options with agent defaults
    const context = this.resolveContext(resolved, options);

    // 2. Setup tool handler and AI SDK tool adapter
    const toolHandler = new ToolHandler(input.target);
    const toolAdapter = new ToolAdapter(toolHandler);

    // 3. Get the system prompt
    const runtime = resolved.runtime as ValidatorRuntime | ExecutorRuntime;
    const systemPrompt = runtime.prompt;

    // 4. Build initial context message
    const initialMessage = await this.buildInitialMessage(input, toolHandler);

    // 5. Execute via AI SDK (tool loop handled automatically)
    const result = await this.aiProvider.generate({
      model: context.model,
      system: systemPrompt,
      prompt: initialMessage,
      tools: toolAdapter.getTools(),
      maxTokens: context.maxTokens,
      maxSteps: 50,
      timeoutMs: context.timeoutMs,
      temperature: 0,
    });

    // 6. Parse structured output
    const parsed = this.outputExtractor.extract(result.text, agentType);

    // 7. Build recommendations
    const recommendations = this.flattenRecommendations(parsed, resolved.name);

    // 8. Compute metrics
    const durationMs = Date.now() - startTime;
    const metrics = {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      cacheCreationTokens: result.usage.cache_creation_input_tokens,
      cacheReadTokens: result.usage.cache_read_input_tokens,
      totalEffectiveTokens: this.calculateEffectiveTokens(result.usage),
      durationMs,
      model: result.model,
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
    const runtime = resolved.runtime as (ValidatorRuntime | ExecutorRuntime) & {
      defaults?: { model?: string; timeout?: number; maxTokens?: number; thresholds?: { pass: number; warn: number } };
    };
    const defaults = runtime?.defaults ?? {};

    return {
      model: (options?.model ?? defaults.model ?? this.config.modelOverride ?? 'sonnet') as ResolvedExecutionContext['model'],
      maxTokens: options?.maxTokens ?? (defaults as { maxTokens?: number }).maxTokens ?? 8192,
      timeoutMs: options?.timeoutMs ?? defaults.timeout ?? this.config.timeout ?? 300_000,
      thresholds: this.resolveThresholds(options?.thresholds, (defaults as { thresholds?: { pass?: number; warn?: number } }).thresholds),
      trackResults: options?.trackResults ?? this.config.trackingEnabled,
      project: options?.project ?? this.config.defaultProject,
    };
  }

  private resolveThresholds(
    optThresholds?: { pass?: number; warn?: number },
    defThresholds?: { pass?: number; warn?: number },
  ): { pass: number; warn: number } | undefined {
    const pass = optThresholds?.pass ?? defThresholds?.pass;
    const warn = optThresholds?.warn ?? defThresholds?.warn;
    if (pass === undefined && warn === undefined) return undefined;
    return { pass: pass ?? 75, warn: warn ?? 50 };
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
      input: { path: '.', pattern: '**/*' },
    });

    const fileList = files.content.split('\n').filter(Boolean);
    const languages = this.detectLanguages(fileList);
    const tree = this.buildTreePreview(fileList, 20);

    return { tree, fileCount: fileList.length, languages };
  }

  private detectLanguages(files: string[]): string[] {
    const langMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript/React',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript/React',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
    };

    const detected = new Set<string>();
    for (const file of files) {
      const ext = file.substring(file.lastIndexOf('.'));
      const lang = langMap[ext];
      if (lang) detected.add(lang);
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
            validator: agentName,
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
    return usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens ?? 0);
  }
}
