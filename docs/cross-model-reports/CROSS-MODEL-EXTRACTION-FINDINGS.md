# Cross-Model Output Extraction Findings

**Date**: 2026-03-10 (updated 2026-03-11)
**Agent**: code-validator v1.5.0
**Target**: Multiple packages (definition-factory, registry-sdk, ops-sdk, agent-metrics, cli, sdk-core, uluops-core-sdk, setup, shell, definition-factory-cli)
**Models Tested**: 16 OpenAI models + Claude haiku baseline
**Commits**: `e4ff816` through `b169b06` (OutputExtractor hardening series)

## Executive Summary

Cross-model testing of the code-validator agent against 14 OpenAI models revealed a **64% extraction failure rate** (9/14 models produced score=0 or decision=ERROR/UNKNOWN). Every model produced valid, high-quality JSON output — the failures were entirely in `OutputExtractor.normalizeOutput()` which assumed a flat JSON shape that only Claude and a few GPT models produce.

After hardening the extractor across 11 failure modes, **gpt-5.1 now extracts reliably at 93.3% (14/15 runs clean)** across 7 packages. The initial 64% failure rate was caused by two issues: (1) `normalizeOutput()` assuming flat JSON shapes, and (2) a **stale `dist/` build** — CLI imports `@uluops/core` from compiled `dist/index.js`, so source changes only affected unit tests (vitest uses tsx on `.ts` directly) until `npm run build` was run. 3 models (gpt-4o-mini, gpt-4.1, gpt-5) have process-level failures (rate limits, timeouts, empty output), not extraction bugs.

## Results Matrix

| Model | Tier | Original | After Fix | Issue |
|-------|------|----------|-----------|-------|
| gpt-4o | Standard | Score 70, FAIL | **Working** | Structured text extraction (no fix needed) |
| gpt-4o-mini | Budget | Score 0, ERROR | **Process failure** | Empty output — hit maxSteps (22 tokens) |
| gpt-4.1 | Standard | N/A | **Process failure** | 30K TPM rate limit — never ran successfully |
| gpt-4.1-nano | Budget | Score 0, PASS | **Fixed** (unit test) | Criteria sub-scores only, no total |
| gpt-5 | Reasoning | Score 0, [OBJECT OBJECT] | **Process failure** | AI SDK timeout — reasoning model too slow |
| gpt-5-mini | Reasoning | Score 0, [OBJECT OBJECT] | **Fixed** (live confirmed: FAIL 92/100) | Stale dist was root cause; nested summary + decision-as-object |
| gpt-5-nano | Reasoning | Score 0, ERROR | **Fixed** (live confirmed) | `status` instead of `decision`; arbitrary wrapper names |
| gpt-5-codex | Coding | Score 0, PASS | **Fixed** (live: PASS 97/100, FAIL 81/100) | `score: {total: 85, ...}` object; varies format between runs |
| **gpt-5.1** | **Flagship** | N/A | **Reliable** (14/15 clean) | See gpt-5.1 deep-dive below |
| gpt-5.1-codex | Coding | Score 0, ERROR | **Fixed** (unit test) | Nested score object |
| gpt-5.2 | Standard | Score 68, FAIL | **Working** | Clean extraction (no fix needed) |
| gpt-5.2-codex | Coding | Score 84, FAIL | **Working** | Structured text extraction (no fix needed) |
| o3-mini | Reasoning | Score 94, PASS | **Working** | Structured text extraction (no fix needed) |
| o4-mini | Reasoning | Score 0, PASS | **Fixed** (live: PASS 96/100) | Code-fenced JSON with `validationResults.score` |
| **claude-haiku-4-5** | **Baseline** | N/A | **PASS 94/100** | Clean extraction, 4 suggestions, 1m 52s |
| **gpt-5.4** | **Flagship** | N/A | **Working** (4/4 clean) | See gpt-5.4 results below |
| gpt-5.4-pro | Reasoning | N/A | **Process failure** | Timeout at 10m — reasoning model too slow (same pattern as gpt-5) |

## gpt-5.4 Verification Results (2026-03-11)

4 runs across 4 packages, all clean extraction:

| # | Target | Score | Decision | Recs | Tokens (in/out) | Time | Status |
|---|--------|-------|----------|------|-----------------|------|--------|
| 1 | setup | 68 | PASS | 9 | 35K/3K | ~60s | Clean |
| 2 | shell | 94 | PASS | 4 | 21K/3K | 56s | Clean |
| 3 | definition-factory-cli | 88 | FAIL | 4 | 31K/4K | 1m 33s | Clean |
| 4 | agent-metrics | 65 | PASS | 6 | 61K/3K | 1m 50s | Clean |

**Success rate**: 4/4 (100%)
**Score range**: 65–94
**Notable findings**: Caught real issues — API key echo in setup, missing PDL type in definition-factory-cli, synchronous busy-wait lock in agent-metrics.

### gpt-5.4-pro Timeout

Both gpt-5.4-pro runs (setup and shell) timed out at 10 minutes (600,000ms). The model is classified as a reasoning model (AI SDK warns "temperature is not supported for reasoning models"). Same failure pattern as gpt-5 — reasoning models are too slow for agent workloads within practical timeout budgets.

## gpt-5.1 Deep-Dive: 15-Run Grinding Results

gpt-5.1 was selected for intensive extraction validation. 15 runs were executed across 7 packages to test consistency.

### Run Results

| # | Target | Score | Recs | Tokens (in/out) | Status |
|---|--------|-------|------|-----------------|--------|
| 1 | registry-sdk | 95 | 4 | 34K/3K | Clean |
| 2 | agent-metrics | 96 | 5 | 31K/5K | Clean |
| 3 | ops-sdk | 92 | 4 | 53K/5K | Clean |
| 4 | agent-metrics | 96 | 5 | 50K/2K | Clean |
| 5 | registry-sdk | 96 | 2 | 34K/3K | Clean |
| 6 | definition-factory | 93 | 8 | 31K/5K | Clean |
| 7 | sdk-core | 96 | 3 | 43K/6K | Clean |
| 8 | cli | 0 | 0 | 242K/3K | **FAILED** |
| 9 | cli | 93 | 5 | 23K/2K | Clean |
| 10 | ops-sdk | 93 | 6 | 53K/5K | Clean |
| 11 | registry-sdk | 93 | 4 | 34K/3K | Clean |
| 12 | agent-metrics | 96 | 3 | 39K/4K | Clean |
| 13 | uluops-core-sdk | 95 | 4 | 28K/4K | Clean |
| 14 | definition-factory | 96 | 3 | 30K/3K | Clean |
| 15 | sdk-core | 96 | 5 | 51K/5K | Clean |

**Success rate**: 14/15 (93.3%)
**Score range**: 92–96 (extremely consistent)
**Recommendations per run**: 2–8

### The Single Failure (Run #8)

The CLI run consumed **242K input tokens** (10x the normal 23K–53K range), indicating the model entered an anomalous deep-browse mode where it read far more files than necessary. This produced malformed output that even the inline JSON extractor couldn't recover. The identical target succeeded on run #9 with 23K tokens and score 93.

**Conclusion**: This is a model behavior anomaly, not an extraction bug. The extractor has no reasonable way to handle output from a 242K-token context that the model itself struggled with.

### JSON Shape Variants Discovered from gpt-5.1

Each run can produce a different JSON structure. Variants discovered:

| Variant | Example | Runs Observed |
|---------|---------|---------------|
| `score: {total: N, ...}` | `"score": {"total": 93, "code_quality": 28}` | Majority |
| `decision: {status: "PASS"}` | Object decision instead of string | Run 9 (cli) |
| `issues.items[]` | Issues nested under items array | Runs 1, 5 |
| `issues.details[]` | Issues nested under details array | Run 3 |
| `report.results.score` | Double-nested score | Run 2 (early) |
| `location: "path:line"` | Combined file+line field | Run 3 |
| Title as `issue` | `"issue": "..."` instead of `"title"` | Run 1 |
| Title as `summary` | `"summary": "..."` instead of `"title"` | Run 5 |
| Title as `message` | `"message": "..."` instead of `"title"` | Run 9 |
| Line as string range | `"line": "24-50"` instead of number | Run 3 |

### Token Usage Patterns

All token data saved correctly to the tracker with full breakdowns:

| Field | Typical Range | Notes |
|-------|--------------|-------|
| `inputTokens` | 23K–53K | Proportional to target codebase size |
| `outputTokens` | 2K–6K | Consistent across runs |
| `cacheReadTokens` | 6K–39K | OpenAI prompt caching active |
| `totalEffectiveTokens` | 25K–58K | Saved to tracker |

## Failure Taxonomy

### FM1: Score as Object
**Models**: gpt-5-codex, gpt-5.1-codex, gpt-5.1
**Shape**: `"score": { "total": 85, "code_quality": 15, ... }`
**Fix**: `resolveScoreField()` checks `score.total`, `.value`, `.overall`, `.final`

### FM2: Decision as Object
**Models**: gpt-5, gpt-5-mini, gpt-5.1
**Shape**: `"decision": { "pass": true, "label": "PASS" }` or `"decision": { "status": "PASS" }`
**Fix**: `resolveDecisionField()` checks `.result`, `.label`, `.value`, `.status`, `.pass` (boolean)

### FM3: Nested Under Wrapper
**Models**: gpt-5-mini, gpt-5-nano (varies per run)
**Shapes**: `summary.score`, `validations.score`, `validation_summary.status`, etc.
**Fix**: `findWrapperWithScoreOrDecision()` scans ALL top-level object values

### FM4: Category Sub-Scores Only
**Models**: gpt-4.1-nano
**Shape**: `"criteria": { "code_quality": { "score": 20 }, ... }` — no total
**Fix**: Score falls back to category sum

### FM5: Alternative Field Names
**Models**: gpt-5-nano
**Shape**: `"status": "PASS"` instead of `"decision"`, `"final_decision": "PASS"`
**Fix**: Widened field name resolution

### FM6: Emoji Prefixed Decisions
**Models**: gpt-5-mini
**Shape**: `"result": "✅ PASS - Ready for next phase"`
**Fix**: `normalizeDecision()` strips emojis before processing

### FM7: Breakdown as Objects
**Models**: gpt-5-nano
**Shape**: `"breakdown": { "CodeQuality": { "points": 30, "deductions": 0 } }`
**Fix**: `resolveCategories()` and `resolveScoreField()` handle `{points, deductions}`

### FM8: Recommendations Not Extracted
**Models**: gpt-5-codex
**Problem**: Only checked `issues` and `issues_found` keys
**Fix**: Added `recommendations`, `warnings`, `findings` keys + wrapper as source

### FM9: Flat Issues Dropped When Categories Exist
**Models**: gpt-5-codex (when `scores` object creates synthetic categories)
**Problem**: Line 394 had `if (!output.categories || output.categories.length === 0)` — flat issues silently dropped
**Fix**: Append issues to empty-findings category or add new "Extracted Issues" category

### FM10: Double-Nested Score (`report.results.score`)
**Models**: gpt-5.1
**Shape**: `"report": { "results": { "score": 96 } }`
**Fix**: Unwrap `report.results` as additional source in resolveScoreField/resolveDecisionField

### FM11: Issues Under `issues.details` or `issues.list`
**Models**: gpt-5.1
**Shape**: `"issues": { "total_issues": 2, "details": [...] }`
**Fix**: Check `details` and `list` alongside `items` for nested issue arrays

## Title/Description Field Resolution

Models use different field names for the same semantic content. Full resolution chain:

| Purpose | Fields Checked (in order) |
|---------|--------------------------|
| Title | `title`, `message`, `issue`, `summary`, `name`, `description` |
| Description | `description`, `details`, `explanation`, `suggestion`, `recommendation` |
| File path | `filePath`, `file_path`, `file`, `path` |
| Line number | `lineNumber`, `line_number`, `line` (number or string range), `line_start` |
| Combined location | `file_line`, `location` (parsed as `"path:line"`) |
| Severity | `severity` (mapped: C→critical, H→high, M→medium, L→low, I→info) |
| Failure code | `failureCode`, `failure_code`, `code` |

Smart title/description logic: when `title` or `message` exists, `description` is used for details. When only `description` exists, it becomes the title and `explanation`/`details` become the description.

## Root Cause: Stale `dist/` Build

The majority of initial live extraction failures were caused by a **stale compiled build**, not code bugs:

- CLI imports `@uluops/core` via `file:../uluops-core-sdk` symlink → resolves to `dist/index.js`
- Source changes to `.ts` files only affected vitest unit tests (which use tsx directly on source)
- All `[OBJECT OBJECT]` and score=0 failures in live CLI runs disappeared after `npm run build`
- **Lesson**: Always run `npm run build` in uluops-core-sdk after source changes before live testing

## AI SDK `result.text` Behavior

Initially suspected that `result.text` concatenated all text across all agent steps (multi-step accumulation). **This was wrong.** AI SDK source confirms:

```typescript
// node_modules/ai/dist/index.js:4512
get text() { return this.finalStep.text; }
```

`result.text` returns only the **last step's text**. The large output sizes (~15K chars for gpt-5-mini) were the model producing verbose final responses, not accumulation across steps.

## Key Design Decisions

### General Wrapper Discovery
Rather than whitelisting specific wrapper names (`validationResults`, `validations`, `validation_summary`, etc.), we implemented `findWrapperWithScoreOrDecision()` which scans ALL top-level object values for ones containing `score`, `decision`, `status`, `breakdown`, or `score_breakdown`. This handles the observed behavior where models produce **different wrapper names on every run**.

### Resilient Field Resolution
The same model (gpt-5.1) used 10+ different field naming patterns across 15 runs. The extractor uses ordered fallback chains for every semantic field rather than expecting specific names.

### Inline JSON: Largest Object Wins
When text contains multiple JSON objects (tool results, partial outputs), the inline extractor searches backwards from the end, collects all valid JSON candidates, and picks the largest one with the most agent-relevant fields (`decision`, `score`, `categories`, etc.).

## Test Coverage

54 tests in `test/parser/OutputExtractor.test.ts` (all passing), including cross-model cases:

| Test Case | Failure Mode | Source Model |
|-----------|-------------|--------------|
| score as nested object with total | FM1 | gpt-5-codex |
| decision as object with label | FM2 | gpt-5 |
| decision as object with result key | FM2 | gpt-5-mini |
| string summary as decision fallback | FM5 | general |
| decision as object with pass boolean (false) | FM2 | general |
| score and decision under summary | FM3 | gpt-5-mini |
| category sub-score summing | FM4 | gpt-4.1-nano |
| code-fenced JSON with validationResults | FM5 | o4-mini |
| flat breakdown sum | FM4 | general |
| score under validations wrapper | FM3 | gpt-5-nano |
| validation_summary with final_decision | FM3+FM5 | gpt-5-nano |
| arbitrary wrapper with points/deductions | FM3+FM7 | gpt-5-nano |
| multi-step output (last JSON wins) | FM7 | gpt-5-mini |
| issues with locations array | general | gpt-5 |
| file_line combined field parsing | general | gpt-5-mini |
| recommendations array as issue source | FM8 | gpt-5-codex |
| issues inside dynamically discovered wrapper | FM8 | general |
| recommendations inside wrapper | FM8 | general |
| description as title fallback | FM title | gpt-5-codex |
| string line range parsing ("24-50") | FM line | gpt-5-codex |
| issue field as title | FM title | gpt-5.1 |
| report.results.score nesting | FM10 | gpt-5.1 |
| issues.details with location field | FM11 | gpt-5.1 |
| summary as title + details as description | FM title | gpt-5.1 |
| inline JSON with prefix text + score.total | FM1 | gpt-5.1 |

Total test suite: 400+ tests (54 OutputExtractor, rest across all modules)

## Files Modified

| File | Changes |
|------|---------|
| `src/parser/OutputExtractor.ts` | ~700 lines added — new resolution methods, enhanced extraction strategies |
| `test/parser/OutputExtractor.test.ts` | ~350 lines added — 25 new cross-model test cases |

## Report Files

All gpt-5.1 reports organized under `docs/cross-model-reports/gpt/5.1/` (32 files).
Earlier model reports organized under `docs/cross-model-reports/gpt/{model}/`.

## Cost Summary

~30 live model runs total. gpt-5.1 runs averaged 25K–58K effective tokens at ~40-100s each. Primary cost was the 15-run gpt-5.1 grinding session.
