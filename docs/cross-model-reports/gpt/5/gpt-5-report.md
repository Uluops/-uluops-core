{
  "report": {
    "phase": "N/A",
    "files_reviewed": [
      "package.json",
      "tsconfig.json",
      "eslint.config.js",
      "vitest.config.ts",
      "src/index.ts",
      "src/parser/yaml-loader.ts",
      "src/parser/ajv-infrastructure.ts",
      "src/parser/error-mapping.ts",
      "src/parser/adl-validator.ts",
      "src/pipelines/shared.ts",
      "src/pipelines/adl.ts",
      "src/renderer/nunjucks-env.ts",
      "src/renderer/filters/shared-filters.ts",
      "src/renderer/pdl-renderer.ts",
      "src/resolvers/filesystem.ts",
      "src/transformer/shared.ts",
      "src/transformer/adl-context-builder.ts",
      "src/types/index.ts",
      "schemas/*.json",
      "test/**/*.test.ts"
    ],
    "summary": {
      "score": 97,
      "code_quality": 27,
      "standards_compliance": 25,
      "testing": 25,
      "best_practices": 20
    }
  },
  "reasoning_trace": {
    "notes": [
      "Language detected: TypeScript (package.json, tsconfig.json).",
      "Linters/tests not executed in this environment. Criteria for style and test execution evaluated via static inspection; no penalties for tool unavailability as per guidance.",
      "Extensive unit/integration tests present across parser, pipelines, renderer, resolver, transformer, and utils. Coverage artifacts exist (coverage/), indicating a configured and previously run suite."
    ],
    "categories": {
      "Code Quality": {
        "score": 27,
        "deductions": [
          {
            "criterion": "Functions are single-purpose",
            "points_lost": 3,
            "failure_code": "PRA-FRA/M",
            "evidence": [
              "src/renderer/pdl-renderer.ts:27-192 — renderPDL() function body spans ~166 lines, blends frontmatter/header/table/triggers/environment/stages/postflight/footer rendering. Consider extracting section renderers (header, metadata table, triggers, environment, footer) — some helpers exist but the top-level remains long.",
              "src/transformer/adl-context-builder.ts:97-169 — buildADLContext() spans ~73 lines. Single responsibility (context assembly) but exceeds the 50-line heuristic; consider extracting frontmatter/workflow handoffs assembly.",
              "src/transformer/adl-context-builder.ts:318-385 — buildJsonStructure() spans ~68 lines. Consider extracting smaller helpers for categories/summary assembly."
            ],
            "context": "Long functions increase maintenance burden and reduce readability even if scope is single-purpose. Refactoring into smaller focused helpers improves testability."
          }
        ]
      },
      "Standards Compliance": {
        "score": 25,
        "deductions": []
      },
      "Testing": {
        "score": 25,
        "deductions": [],
        "evidence": [
          "Unit tests exist for all major areas: parser (test/parser/*), pipelines (test/pipelines/*), renderer (test/renderer/* including nunjucks filters and PDL rendering), resolver (test/resolvers/filesystem.test.ts), transformer (test/transformer/*), and utilities (test/utils/*).",
          "Edge cases covered: test/edge-cases.test.ts includes null/whitespace YAML, missing root keys, ref parsing anomalies.",
          "Behavior-focused assertions observed (e.g., validation error messages/paths in test/parser/schema-validator.test.ts)."
        ],
        "tooling_note": "Could not execute tests here; evaluated by inspection. No penalties applied per 'Missing tooling' guidance."
      },
      "Best Practices": {
        "score": 20,
        "deductions": [],
        "evidence": [
          "No hardcoded secrets or tokens found via search; schemas mention secrets abstractly, not concrete values.",
          "Filesystem resolver validates names (src/resolvers/filesystem.ts:137-141) and avoids path traversal by constraining filenames; YAML parsing is guarded; transient FS error retry is implemented.",
          "Nunjucks autoescape intentionally disabled for Markdown output with prominent doc comment (src/renderer/nunjucks-env.ts:72-87) warning consumers to sanitize if rendering as HTML."
        ]
      }
    }
  },
  "issues": {
    "total_issues": 4,
    "by_severity": {
      "critical": 0,
      "high": 0,
      "medium": 3,
      "low": 1,
      "info": 0
    },
    "by_domain": {
      "PRA": 3,
      "SEM": 1,
      "STR": 0,
      "EPI": 0
    },
    "by_category": {
      "Code Quality": 3,
      "Standards Compliance": 0,
      "Testing": 0,
      "Best Practices": 1
    },
    "items": [
      {
        "title": "Large function exceeds 50-line heuristic (renderPDL)",
        "category": "Code Quality",
        "file": "src/renderer/pdl-renderer.ts",
        "line": 27,
        "failure_code": "PRA-FRA/M",
        "explanation": "renderPDL() spans ~166 lines and mixes orchestration for many rendering concerns. While helpers exist for sections, the top-level remains long, which increases maintenance burden.",
        "suggestion": "Extract header/metadata table/environment/footer orchestration into smaller helpers and keep renderPDL focused on high-level sequencing."
      },
      {
        "title": "Function longer than 50 lines (buildADLContext)",
        "category": "Code Quality",
        "file": "src/transformer/adl-context-builder.ts",
        "line": 97,
        "failure_code": "PRA-FRA/M",
        "explanation": "buildADLContext() (~73 lines) handles render profile resolution, extension flags, sanitation, and computed fields assembly in one block.",
        "suggestion": "Extract frontmatter/handoffs assembly into dedicated helpers and keep core context mapping concise."
      },
      {
        "title": "Function longer than 50 lines (buildJsonStructure)",
        "category": "Code Quality",
        "file": "src/transformer/adl-context-builder.ts",
        "line": 318,
        "failure_code": "PRA-FRA/M",
        "explanation": "buildJsonStructure() (~68 lines) constructs multiple nested objects. Refactoring improves readability.",
        "suggestion": "Extract issue template/category assembly and byType summary into helper functions."
      },
      {
        "title": "Document sanitization responsibility when rendering Markdown as HTML",
        "category": "Best Practices",
        "file": "src/renderer/nunjucks-env.ts",
        "line": 72,
        "failure_code": "SEM-INC/L",
        "explanation": "Autoescape is disabled for Markdown correctness; if consumers render Markdown as HTML without sanitization, XSS risks exist.",
        "suggestion": "Reiterate in README that rendered Markdown must be sanitized before HTML rendering in untrusted contexts. Provide a recommended sanitizer."
      }
    ]
  },
  "auto_fail_conditions": {
    "AF-001_security_vulnerabilities_detected": "CLEAR",
    "AF-002_missing_error_handling_in_critical_paths": "CLEAR",
    "AF-003_code_does_not_function": "CLEAR",
    "AF-004_missing_tests_for_core_functionality": "CLEAR",
    "AF-005_breaking_changes_without_migration_path": "CLEAR"
  },
  "decision": {
    "pass": true,
    "label": "PASS - Ready for next phase",
    "reasoning": "Score 97/100 (>=70) with no critical issues. Codebase shows strong structure, comprehensive tests, and adherence to best practices. Only noted medium-severity maintainability items (large functions) and a low-severity documentation reminder regarding sanitization."
  },
  "validation_checks": {
    "completeness": {
      "all_categories_scored": true,
      "deductions_have_references": true,
      "issues_have_failure_codes": true,
      "auto_fail_reviewed": true,
      "decision_aligns_with_score": true
    }
  }
}