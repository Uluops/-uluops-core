# ADR-001: Decision Vocabulary Architecture

**Status:** Accepted
**Date:** 2026-04-15
**Context:** name-game pipeline run #1 (confucius-analyst, wittgenstein-analyst, negative-space-analyst)

## Decision

The four-register decision vocabulary is intentional. Each execution layer uses a vocabulary appropriate to its domain:

| Layer | Vocabulary | Semantics |
|-------|-----------|-----------|
| Validator agents | `PASS` / `WARN` / `FAIL` | Quality assessment |
| Executor agents | `COMPLETE` / `PARTIAL` / `FAILED` | Task completion |
| Workflows | `SHIP` / `HOLD` / `BLOCK` | Release readiness |
| Phases | `passed` / `warned` / `blocked` / `skipped` / `aborted` | Phase state history |

## Normalization

The `classifyDecision()` helper in `src/executor/classifyDecision.ts` is the canonical normalizer. It maps any decision string to a `DecisionCategory`:

- **positive:** `PASS`, `SHIP`, `COMPLETE`
- **negative:** `FAIL`, `FAILED`, `BLOCK`
- **conditional:** `WARN`, `HOLD`, `PARTIAL` (partial completion is progress, not failure)
- **neutral:** unknown/undefined values

Both `computeDecision()` and stage counting metrics in `PipelineExecutor` use this helper to ensure symmetric logic.

## Adding New Decision Values

Custom decision values from agent definitions (e.g., `EXAMINED`/`UNEXAMINED`, `VITAL`/`DECADENT`) are resolved automatically via `buildVocabularyMap()`, which reads the agent's `decisions.vocabulary` or `completion.vocabulary` fields. No switch statement modification needed.

The hardcoded core vocabularies (PASS/FAIL/SHIP/BLOCK/etc.) in the switch statement are a fallback for decisions without a vocabulary map. They cover the four execution layers above and should rarely need updating.

## Background

The name-game pipeline produced a three-way interpretive divergence on this vocabulary:
- Confucius-analyst: DISORDERED (naming drift requiring rectification)
- Wittgenstein-analyst: CLEAR (distinct language-games appropriate to each layer)
- Negative-space-analyst: INTENTIONAL (boundary speaks the local language)

Resolution: the registers are intentional; the collapse mechanism is now formalized via `classifyDecision()`.
