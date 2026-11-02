import type { ExecutionResult } from '../types/execution.js';
import type { AgentResult } from '../types/agent.js';
import type { WorkflowResult } from '../types/workflow.js';
import type { PipelineResult } from '../types/pipeline.js';
import type { CommandResult } from '../types/command.js';
import { CRASH_PLACEHOLDER_VERSION } from '../utils/crashPlaceholder.js';

/**
 * Every agent result under a composite result whose analysis is submitted, in walk order
 * (submission-analysis-fidelity spec v0.2.1, D3). Crash and aborted placeholders are skipped: they
 * carry no analysis.
 *
 * This is the analysis path's traversal ONLY. Agent rows and execution recording keep their own
 * decomposition in SubmissionClient (skip filters, non-agent fallbacks, nested caps), which this
 * deliberately does not reproduce. The test that the two agree is V8, against hand-written
 * expectations per composite shape.
 *
 * Until 0.57.0 this logic was inline and returned nothing for a pipeline's workflow-ref stage,
 * whose result is `{ result: WorkflowResult }` with no `agentResults`: its agents had tracker rows
 * but no summaries and no records (§1.4).
 *
 * Precedence within a pipeline stage is by field, not stage type (an aborted or stopped workflow
 * stage can carry `agentResults` directly): the stage's own `agentResults`, else the agents of the
 * CommandResult or WorkflowResult it holds.
 */
export function analysisChildren(result: ExecutionResult | AgentResult): AgentResult[] {
  return walk(result).filter(agent => agent.version !== CRASH_PLACEHOLDER_VERSION);
}

function walk(result: ExecutionResult | AgentResult | undefined): AgentResult[] {
  if (!result) return [];
  if (isPipeline(result)) {
    return result.stages.flatMap(stage => stage.agentResults && stage.agentResults.length > 0
      ? stage.agentResults
      : walk(stage.result));
  }
  if (isWorkflow(result)) {
    return result.phases.flatMap(phase => phase.commands.flatMap(cmd => cmd.agentResults ?? []));
  }
  if (isCommand(result)) return result.agentResults ?? [];
  return [];
}

function isPipeline(r: ExecutionResult | AgentResult): r is PipelineResult {
  return r.type === 'pipeline' && Array.isArray((r as PipelineResult).stages);
}

function isWorkflow(r: ExecutionResult | AgentResult): r is WorkflowResult {
  return r.type === 'workflow' && Array.isArray((r as WorkflowResult).phases);
}

function isCommand(r: ExecutionResult | AgentResult): r is CommandResult {
  return r.type === 'command';
}
