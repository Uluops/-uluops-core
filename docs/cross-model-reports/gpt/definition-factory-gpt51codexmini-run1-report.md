🔍 VALIDATOR REPORT - PHASE [N/A - Aggregate Review]

Files Reviewed:
- package.json
- README.md
- src/renderer/pdl-renderer.ts
- src/pipelines/pdl.ts
- src/index.ts
- src/transformer/adl-context-builder.ts
- test/parser/schema-validator.test.ts
- test/edge-cases.test.ts
- tsconfig.json
- eslint.config.js

━━━━━━━━━━━━━━━━━━━━━━━━━━
VALIDATION RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Score: 79/100

Code Quality:      25/30
Standards Compliance:22/25
Testing:           12/25
Best Practices:    20/20

━━━━━━━━━━━━━━━━━━━━━━━━━━
REASONING TRACE
━━━━━━━━━━━━━━━━━━━━━━━━━━

**Code Quality** (25/30):
- single_purpose_functions: -3 pts  
  Evidence: `src/renderer/pdl-renderer.ts:27-190` – `renderPDL()` spans hundreds of lines and manually stages frontmatter, headers, metadata tables, triggers, environment, dependency graphs, rollbacks, notifications, artifacts, state, postflight, and footer.  
  Context: This monolithic function performs the entire pipeline rendering, making it fragile to change and hard to test; splitting into smaller helpers would restore single-responsibility. `PRA-FRA/M`
- complexity_is_manageable: -2 pts  
  Evidence: Same `renderPDL()` block includes deeply nested loops for triggers, secrets, notifications, artifacts, and multiple helper renderers (stages, rollbacks, postflight, dependency graph).  
  Context: Cyclomatic paths exceed the 10-line guideline for JS functions and the similar helper functions are already 200+ lines, increasing maintenance burden. `PRA-FRA/M`

**Standards Compliance** (22/25):
- documentation_present: -3 pts  
  Evidence: README line 12 claims "**Current version: 0.13.0**" while `package.json` line 3 declares version `0.19.1`.  
  Context: Public-facing documentation advertises the wrong package version, undermining trust and upgrade guidance. `STR-INC/M`

**Testing** (12/25):
- unit_tests_exist: -10 pts  
  Evidence: There are zero tests invoking `pdl.generate()` or `renderPDL()`; the only PDL reference is in `test/parser/schema-validator.test.ts:466-484`, which only checks AJV schema registration, not pipeline behavior.  
  Context: The exported PDL pipeline (parse→validate→render) is core functionality with no unit/integration coverage, so regressions cannot be detected. `STR-OMI/H`
- edge_cases_covered: -3 pts  
  Evidence: Same absence as above; every other pipeline (ADL/CDL/WDL) has dedicated edge-case suites, but PDL has no tests covering triggers, stages, rollbacks, or renderer edge cases.  
  Context: Missing coverage for PDL means boundary logic (e.g., missing tracker, secrets, approvals) is unverified. `SEM-COM/M`
- tests_actually_run: 0 pts deducted (not executed)  
  Evidence: Unable to run `npm test` in this environment because shell commands are unavailable; rely on existing coverage artifacts but cannot confirm runtime results.  
  Context: Mentioned for transparency—no direct ballot but no deduction to avoid flagging tool limitation.

**Best Practices** (20/20):
- No issues observed; defaults (no hardcoded secrets, separation of concerns maintained, dependencies justified).

━━━━━━━━━━━━━━━━━━━━━━━━━━
ISSUES FOUND
━━━━━━━━━━━━━━━━━━━━━━━━━━

🔴 CRITICAL (Must Fix):
- Missing PDL pipeline tests: `test/parser/schema-validator.test.ts:466-484` [STR-OMI/H]  
  Only the AJV schema registration for `pdl` is exercised; no unit or integration test covers `pdl.generate()` or `renderPDL()`, leaving every exported pipeline path unverified. Core pipeline functionality is effectively ship-without-tests, triggering AF-004.

🟡 WARNINGS (Should Fix):
- Monolithic `renderPDL()` violates single responsibility and blows past complexity limits: `src/renderer/pdl-renderer.ts:27-190` [PRA-FRA/M]  
  `renderPDL()` builds the entire markdown output inline (frontmatter, metadata, triggers, vaults, stages, rollbacks, notifications, artifacts, state, postflight, dependency graph, footer) and delegates to tiny helpers only at the end. Refactor into smaller, focused builders to keep cyclomatic complexity and length manageable.

🔵 SUGGESTIONS (Consider):
- README version number outdated: `README.md:12` vs `package.json:3` [STR-INC/M]  
  The README still advertises version 0.13.0 while the package is at 0.19.1, confusing consumers and undermining release notes. Update the “Current version” banner to match `package.json`.

━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTO-FAIL CONDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━

AF-001 Security vulnerabilities detected: [✅ Clear]  
AF-002 Missing error handling in critical paths: [✅ Clear]  
AF-003 Code does not function: [✅ Clear]  
AF-004 Missing tests for core functionality: [🔴 TRIGGERED] — PDL pipeline lacks any unit/integration coverage (only schema registration is tested).  
AF-005 Breaking changes without migration path: [✅ Clear]

━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION
━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ FAIL - Critical issues must be fixed

Reasoning: Although the aggregate score is 79/100, AF-004 is triggered because the PDL parse/validate/render pipeline has zero behavioral tests, leaving core functionality unverified. The phase cannot advance until PDL generation/rendering are covered by tests.