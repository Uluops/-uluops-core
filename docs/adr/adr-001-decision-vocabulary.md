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
- **negative:** `FAIL`, `FAILED`, `BLOCK`, `PARTIAL`
- **conditional:** `WARN`, `HOLD`
- **neutral:** unknown/undefined values

Both `computeDecision()` and stage counting metrics in `PipelineExecutor` use this helper to ensure symmetric logic.

## Adding New Decision Values

New decision values (e.g., from custom agent `decisions` sections) MUST be registered in the `classifyDecision` switch statement. Without registration, they route to `neutral` and will not be counted in pipeline metrics.

## Background

The name-game pipeline produced a three-way interpretive divergence on this vocabulary:
- Confucius-analyst: DISORDERED (naming drift requiring rectification)
- Wittgenstein-analyst: CLEAR (distinct language-games appropriate to each layer)
- Negative-space-analyst: INTENTIONAL (boundary speaks the local language)

Resolution: the registers are intentional; the collapse mechanism is now formalized via `classifyDecision()`.
