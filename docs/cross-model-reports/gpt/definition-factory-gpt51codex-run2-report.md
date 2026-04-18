{
  "report": {
    "phase": "N/A",
    "files_reviewed": [
      "package.json",
      "src/pipelines/pdl.ts",
      "src/pipelines/cdl.ts",
      "src/pipelines/shared.ts",
      "src/parser/yaml-loader.ts",
      "src/resolvers/filesystem.ts",
      "src/renderer/pdl-renderer.ts",
      "test/smoke.test.ts",
      "test/edge-cases.test.ts",
      "test/parser/schema-validator.test.ts"
    ],
    "score": 75,
    "category_scores": {
      "code_quality": 25,
      "standards_compliance": 25,
      "testing": 10,
      "best_practices": 15
    },
    "reasoning": {
      "code_quality": "renderPDL (src/renderer/pdl-renderer.ts:27-193) centralizes almost every rendering concern in a single 160+ line function. That violates the single-purpose expectation for exported helpers, so 5 pts were deducted for the single-purpose criterion.",
      "standards_compliance": "Formatting, lint configuration, and documentation are consistent with the repo standards; no deductions applied.",
      "testing": "While ADL/CDL/WDL paths are covered extensively, the PDL pipeline/render path has zero behavioral tests—the only PDL mentions are schema compilation checks (test/parser/schema-validator.test.ts:469-485). Missing tests for a shipped pipeline cost all unit-test points and edge-case coverage points.",
      "best_practices": "The filesystem resolver performs synchronous disk I/O inside async methods (src/resolvers/filesystem.ts:48-127), blocking the event loop for each resolve call. This violates the 'no blocking sync work in async paths' guidance, so 5 pts were deducted."
    }
  },
  "issues": [
    {
      "issue_type": "code_quality",
      "severity": "medium",
      "failure_code": "PRA-FRA/M",
      "title": "renderPDL handles all rendering concerns in one 160+ line function",
      "location": {
        "file": "src/renderer/pdl-renderer.ts",
        "line": "27-193"
      },
      "description": "renderPDL builds front matter, triggers, environment tables, dependency graphs, stages, rollback, notifications, artifacts, state, postflight, and footer logic all inline. At 160+ lines with many nested responsibilities, it is difficult to reason about or unit-test and violates the single-purpose guidance.",
      "recommendation": "Decompose renderPDL into smaller helpers (e.g., renderFrontmatter, renderTriggers, renderStages, renderPostflight) and orchestrate them from a short coordinator."
    },
    {
      "issue_type": "testing",
      "severity": "high",
      "failure_code": "STR-OMI/H",
      "title": "No tests exercise the PDL pipeline or renderer",
      "location": {
        "file": "test/parser/schema-validator.test.ts",
        "line": "469-485"
      },
      "description": "A search across test/**/*.ts shows the only PDL-focused tests are the schema registration checks in test/parser/schema-validator.test.ts:469-485. None of the suites call pdl.parse, pdl.generate, or renderPDL, so regressions in the PDL renderer and pipeline will ship undetected.",
      "recommendation": "Add unit/integration tests that cover parse → validate → render for representative PDL pipelines, including edge cases (no triggers, rollback enabled, etc.), to ensure the exported pipeline stays functional."
    },
    {
      "issue_type": "best_practices",
      "severity": "medium",
      "failure_code": "PRA-EFF/M",
      "title": "Async filesystem resolver performs blocking synchronous I/O",
      "location": {
        "file": "src/resolvers/filesystem.ts",
        "line": "48-127"
      },
      "description": "resolveAgent/resolveCommand are async but call existsSync and readFileSync inside searchDefinitionFile/readFileWithRetry. In server contexts this blocks the event loop for each resolution and violates the guideline against synchronous blocking in async code paths.",
      "recommendation": "Replace readFileSync/existsSync with fs.promises equivalents (or expose a synchronous resolver API) so async callers do not incur blocking disk I/O."
    }
  ],
  "issue_summary": {
    "total": 3,
    "by_severity": {
      "high": 1,
      "medium": 2,
      "low": 0
    },
    "by_domain": {
      "STR": 1,
      "PRA": 2
    },
    "by_type": {
      "testing": 1,
      "code_quality": 1,
      "best_practices": 1
    }
  },
  "auto_fail": {
    "AF-001_security_vulnerabilities": "clear",
    "AF-002_error_handling": "clear",
    "AF-003_code_functionality": "clear",
    "AF-004_missing_core_tests": "triggered",
    "AF-005_breaking_changes": "clear"
  },
  "decision": {
    "status": "FAIL",
    "reason": "Score met the numeric threshold (75) but AF-004 is triggered because the shipped PDL pipeline/renderer has no behavioral tests, so the phase cannot advance until core coverage exists."
  }
}