```json
{
  "decision": "FAIL",
  "score": 68,
  "threshold": 70,
  "auto_fail_triggered": ["AF-004"],
  "files_reviewed": [
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "vitest.config.ts",
    "src/index.ts",
    "src/pipelines/{adl,cdl,wdl,pdl,shared}.ts",
    "src/parser/{ajv-infrastructure,yaml-loader,cdl-validator,pdl-validator,index}.ts",
    "src/resolvers/filesystem.ts",
    "src/renderer/{cleanup,pdl-renderer}.ts",
    "test/smoke.test.ts",
    "test/edge-cases.test.ts",
    "test/parser/schema-validator.test.ts",
    "test/renderer/{cdl-renderer,wdl-renderer}.test.ts"
  ],
  "score_breakdown": {
    "code_quality": { "score": 22, "out_of": 30 },
    "standards_compliance": { "score": 22, "out_of": 25 },
    "testing": { "score": 12, "out_of": 25 },
    "best_practices": { "score": 12, "out_of": 20 }
  },
  "issues": [
    {
      "severity": "high",
      "failure_code": "STR-OMI/H",
      "type": "testing",
      "title": "Core PDL pipeline is not covered by any unit/integration test",
      "file_path": "test/**/*",
      "line_number": 1,
      "description": "PDL is part of the primary public API (src/index.ts exports { adl, cdl, wdl, pdl }), but the test suite contains no usage/coverage of pdl.parse / pdl.validate / pdl.generate or renderPDL. Searches for parsePDL/validatePDL/renderPDL in test/**/*.ts returned no matches; only schema registration is tested via getValidator('pdl'). This is missing tests for core functionality.",
      "evidence": [
        "src/index.ts:10 exports { adl, cdl, wdl, pdl }",
        "src/pipelines/pdl.ts:34-42 implements PDL generate()",
        "test/**: no matches for parsePDL|validatePDL|renderPDL|pdl.generate",
        "test/parser/schema-validator.test.ts:469-485 only validates schema compilation for PDL"
      ],
      "suggestion": "Add at least one PDL test that exercises parse→validate→render via pdl.generate() (happy path) and one semantic-warning path (e.g., depends_on references unknown stage) to ensure pipeline behavior is stable."
    },
    {
      "severity": "high",
      "failure_code": "SEM-INC/H",
      "type": "testing",
      "title": "Pipeline smoke tests depend on external monorepo fixtures and are skipped when unavailable",
      "file_path": "test/smoke.test.ts",
      "line_number": 26,
      "description": "Key pipeline tests for ADL/CDL/WDL are conditionally skipped if external directories are missing (uluops-agent-workflows). This reduces reliability of 'npm test' in isolated CI or package consumers, and can allow regressions in generate() pipelines to slip through if fixtures aren't present.",
      "evidence": [
        "test/smoke.test.ts:27-35 external fixture paths + existsSync checks",
        "test/smoke.test.ts:96,150,204 describe.skipIf(!has*Fixtures)(...)"
      ],
      "suggestion": "Add self-contained fixtures under test/fixtures for ADL/CDL/WDL smoke generation so pipeline tests always run. Keep external-fixture tests as optional extras if desired."
    },
    {
      "severity": "medium",
      "failure_code": "PRA-FRA/M",
      "type": "code_quality",
      "title": "Large renderer function/file increases fragility and maintenance cost",
      "file_path": "src/renderer/pdl-renderer.ts",
      "line_number": 27,
      "description": "PDL renderer is implemented as a single large module (~587 lines) with many responsibilities (frontmatter, environment tables, dependency graph, stages, rollback, notifications, artifacts, state, postflight, plus helpers). This exceeds the guideline of <50 lines per function (and indicates complexity).",
      "evidence": [
        "src/renderer/pdl-renderer.ts:27 renderPDL() plus extensive helper logic; file length 587 lines"
      ],
      "suggestion": "Split into focused helpers/modules (e.g., renderFrontmatter(), renderEnvironment(), renderStages(), renderRollback(), renderPostflight(), dependency-graph builder) and add unit tests for each section output."
    },
    {
      "severity": "medium",
      "failure_code": "STR-OMI/M",
      "type": "standards",
      "title": "Parser index omits PDL exports, creating inconsistent public API surface",
      "file_path": "src/parser/index.ts",
      "line_number": 1,
      "description": "src/parser/index.ts exports parse/validate helpers for ADL/CDL/WDL but omits parsePDL/isPDLFile/validatePDL. Meanwhile src/index.ts re-exports isPDLFile from yaml-loader. This inconsistency can confuse consumers expecting parser barrel parity.",
      "evidence": [
        "src/parser/index.ts:1-17 does not export parsePDL/isPDLFile/validatePDL",
        "src/parser/yaml-loader.ts:176-192 defines parsePDL and isPDLFile",
        "src/parser/pdl-validator.ts:15 defines validatePDL"
      ],
      "suggestion": "Export parsePDL/isPDLFile and validatePDL from src/parser/index.ts for consistency with other definition types."
    },
    {
      "severity": "low",
      "failure_code": "PRA-EFF/M",
      "type": "best_practices",
      "title": "Synchronous filesystem reads used in resolver and version detection (potentially blocking in server usage)",
      "file_path": "src/resolvers/filesystem.ts",
      "line_number": 10,
      "description": "FileSystemResolver relies on readFileSync/existsSync during resolution; adl-context-builder reads package.json via readFileSync to infer version. This is acceptable for CLI usage, but can become a performance/latency issue if used in server request paths.",
      "evidence": [
        "src/resolvers/filesystem.ts:10-16 uses readFileSync/existsSync",
        "src/transformer/adl-context-builder.ts:31-33 reads package.json synchronously"
      ],
      "suggestion": "Document intended usage (CLI/startup only) more explicitly and/or provide async resolver variants if server-side usage is expected."
    }
  ],
  "issue_summary": {
    "total_issues": 5,
    "by_severity": { "critical": 0, "high": 2, "medium": 2, "low": 1, "info": 0 },
    "by_domain": { "PRA": 2, "SEM": 2, "STR": 1, "EPI": 0 },
    "by_type": { "code_quality": 1, "standards": 1, "testing": 2, "best_practices": 1 }
  },
  "category_scoring_notes": {
    "code_quality": {
      "awarded_points": 22,
      "deductions": [
        {
          "points_lost": 8,
          "failure_code": "PRA-FRA/M",
          "evidence": "src/renderer/pdl-renderer.ts (587 lines; many responsibilities)"
        }
      ]
    },
    "standards_compliance": {
      "awarded_points": 22,
      "deductions": [
        {
          "points_lost": 3,
          "failure_code": "STR-OMI/M",
          "evidence": "src/parser/index.ts:1-17 missing PDL exports while other definition types are present"
        }
      ]
    },
    "testing": {
      "awarded_points": 12,
      "deductions": [
        {
          "points_lost": 10,
          "failure_code": "STR-OMI/H",
          "evidence": "No tests call pdl.parse/pdl.validate/pdl.generate/renderPDL; only schema compile test exists (test/parser/schema-validator.test.ts:469-485)"
        },
        {
          "points_lost": 3,
          "failure_code": "SEM-INC/H",
          "evidence": "test/smoke.test.ts:96/150/204 uses describe.skipIf(!has*Fixtures) for core pipeline smoke tests"
        }
      ]
    },
    "best_practices": {
      "awarded_points": 12,
      "deductions": [
        {
          "points_lost": 3,
          "failure_code": "PRA-EFF/M",
          "evidence": "src/resolvers/filesystem.ts:10-16 sync FS; src/transformer/adl-context-builder.ts:31-33 sync read"
        },
        {
          "points_lost": 5,
          "failure_code": "PRA-MAT/M",
          "evidence": "Not deducted (no clear violation found in reviewed files)"
        }
      ],
      "notes": "No hardcoded secrets detected in src/**/*.ts (secret-like strings found were schema/docs/test examples)."
    }
  },
  "auto_fail_conditions": {
    "AF-001_security_vulnerabilities_detected": "clear",
    "AF-002_missing_error_handling_in_critical_paths": "clear",
    "AF-003_code_does_not_function": "clear",
    "AF-004_missing_tests_for_core_functionality": "triggered",
    "AF-005_breaking_changes_without_migration_path": "clear"
  },
  "tooling_observations": {
    "language_detected": "TypeScript (NodeNext / ESM), Vitest, ESLint",
    "lint_config_present": true,
    "test_config_present": true,
    "tests_present": true,
    "notes": "Automated lint/test execution was not performed in this run (tooling limited to file reads/search). Findings are based on static inspection and repository structure."
  },
  "next_steps": [
    "Add direct PDL pipeline tests (parse/validate/generate/render) under test/ (self-contained fixtures).",
    "Remove or reduce reliance on external monorepo fixtures for smoke tests; provide local minimal YAML fixtures.",
    "Consider refactoring src/renderer/pdl-renderer.ts into smaller units and test them.",
    "Export PDL helpers from src/parser/index.ts to align with other definition types."
  ]
}
```