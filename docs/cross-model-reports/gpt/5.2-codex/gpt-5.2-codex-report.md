🔍 VALIDATOR REPORT - PHASE 1

Files Reviewed:
- src/renderer/pdl-renderer.ts
- src/pipelines/pdl.ts
- src/pipelines/shared.ts
- src/resolvers/filesystem.ts
- src/index.ts
- test/parser/schema-validator.test.ts

━━━━━━━━━━━━━━━━━━━━━━━━━━
VALIDATION RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Score: 84/100

Code Quality:         24/30
Standards Compliance: 25/25
Testing:              15/25
Best Practices:       20/20

━━━━━━━━━━━━━━━━━━━━━━━━━━
REASONING TRACE
━━━━━━━━━━━━━━━━━━━━━━━━━━

**Code Quality** (24/30):
- Functions are single-purpose: -3 pts  
  Evidence: `renderPDL()` is ~166+ lines long and performs many responsibilities (frontmatter, metadata, triggers, environment, stages, rollback, notifications, artifacts, state, postflight, footer).  
  File: `src/renderer/pdl-renderer.ts:27-193` [PRA-FRA/M]  
  Context: This reduces maintainability and makes future changes risky; rendering stages should be broken into smaller helpers.

- Complexity is manageable: -3 pts  
  Evidence: Same function `renderPDL()` has extensive branching and sequential formatting logic in one block.  
  File: `src/renderer/pdl-renderer.ts:27-193` [PRA-FRA/M]  
  Context: The monolithic structure increases cyclomatic complexity and reduces testability.

**Standards Compliance** (25/25):
- No issues found. Formatting, imports, and docs appear consistent.

**Testing** (15/25):
- Unit tests exist for new code: -10 pts  
  Evidence: No renderer or pipeline tests covering PDL generation. There is no `pdl-renderer.test.ts` or any test referencing `renderPDL` or PDL pipeline generation.  
  Source of untested logic: `src/renderer/pdl-renderer.ts:27` and `src/pipelines/pdl.ts:34` [STR-OMI/H]  
  Context: PDL renderer is core functionality and should be validated with unit tests.

- Tests actually run and pass: 0 pts deducted (tooling not executed in this environment).  
  Note: Test execution could not be verified; no penalty per instructions.

**Best Practices** (20/20):
- No security, performance, or separation-of-concern issues detected in sampled code.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ISSUES FOUND
━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 CRITICAL (Must Fix):
- Missing unit tests for core PDL renderer/pipeline: `src/renderer/pdl-renderer.ts:27`, `src/pipelines/pdl.ts:34` [STR-OMI/H]  
  Core PDL rendering and pipeline generation are not covered by tests. This violates unit test requirements for core functionality.

🟡 WARNINGS (Should Fix):
- Monolithic render function exceeding 50 lines: `src/renderer/pdl-renderer.ts:27-193` [PRA-FRA/M]  
  Consider extracting sections (frontmatter, triggers, environment, stages, postflight) into dedicated helper functions.

- Complexity/branching concentrated in a single function: `src/renderer/pdl-renderer.ts:27-193` [PRA-FRA/M]  
  The function mixes formatting, control flow, and fallback logic; splitting will reduce cyclomatic complexity.

━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTO-FAIL CONDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━

AF-001 Security vulnerabilities detected: ✅ Clear  
AF-002 Missing error handling in critical paths: ✅ Clear  
AF-003 Code does not function: ✅ Clear  
AF-004 Missing tests for core functionality: 🔴 TRIGGERED  
AF-005 Breaking changes without migration path: ✅ Clear

━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION
━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ FAIL - Critical issues must be fixed

Reasoning: Score is 84/100 but auto-fail condition AF-004 is triggered due to missing tests for core PDL rendering and pipeline functionality. Add unit tests covering `renderPDL()` and `generate()` in `pdl.ts` before proceeding.