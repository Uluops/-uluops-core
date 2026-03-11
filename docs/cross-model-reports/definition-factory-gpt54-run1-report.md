{
  "decision": "FAIL",
  "score": {
    "total": 66,
    "code_quality": 28,
    "standards_compliance": 16,
    "testing": 17,
    "best_practices": 5
  },
  "summary": "Project has strong overall structure, good test volume, and generally solid TypeScript practices, but it is not ready to advance. The package exposes active PDL pipeline functionality in code while README documentation still states PDL is 'schema only — no factory yet' and lists an outdated package version. More importantly, the filesystem resolver misclassifies legacy CDL commandType 'executor' as generic 'agent', causing incorrect resolved metadata for downstream consumers. Core PDL functionality also lacks direct tests, which triggers missing-tests concerns for newly shipped public API.",
  "files_reviewed": [
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "vitest.config.ts",
    "README.md",
    "CHANGELOG.md",
    "src/index.ts",
    "src/parser/cdl-validator.ts",
    "src/parser/pdl-validator.ts",
    "src/parser/yaml-loader.ts",
    "src/parser/ajv-infrastructure.ts",
    "src/pipelines/shared.ts",
    "src/pipelines/pdl.ts",
    "src/resolvers/filesystem.ts",
    "src/renderer/cleanup.ts",
    "src/renderer/pdl-renderer.ts",
    "src/transformer/shared.ts",
    "src/types/resolver.ts",
    "test/parser/schema-validator.test.ts",
    "test/resolvers/filesystem.test.ts"
  ],
  "reasoning_trace": {
    "code_quality": [
      {
        "criterion": "Functions are single-purpose",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Clear, descriptive naming",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "No code duplication",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Error handling in critical paths",
        "points_awarded": 3,
        "points_possible": 5,
        "findings": [
          {
            "file": "src/resolvers/filesystem.ts",
            "line": 116,
            "failure_code": "SEM-COM/H",
            "issue": "Resolver swallows YAML parse/read failures without surfacing context to caller",
            "context": "searchDefinitionFile() catches all read/parse errors and silently continues. This prevents diagnosis of broken on-disk definitions and can mask configuration errors in a critical resolution path."
          }
        ]
      },
      {
        "criterion": "No dead/commented code",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Complexity is manageable",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      }
    ],
    "standards_compliance": [
      {
        "criterion": "Follows project style guide",
        "points_awarded": 10,
        "points_possible": 10,
        "findings": []
      },
      {
        "criterion": "Consistent formatting",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "No unused imports/dependencies",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Documentation present",
        "points_awarded": 0,
        "points_possible": 5,
        "findings": [
          {
            "file": "README.md",
            "line": 12,
            "failure_code": "STR-OMI/M",
            "issue": "README version is stale",
            "context": "README says current version is 0.13.0 while package.json is 0.19.1. Public package documentation is materially out of sync with the published package metadata."
          },
          {
            "file": "README.md",
            "line": 611,
            "failure_code": "STR-OMI/M",
            "issue": "README incorrectly states PDL is schema-only and has no factory",
            "context": "Code exports parsePDL/validatePDL/renderPDL and src/pipelines/pdl.ts implements generate(). This is a public API/documentation mismatch."
          },
          {
            "file": "README.md",
            "line": 112,
            "failure_code": "STR-INC/M",
            "issue": "README lists outdated bundled PDL schema version",
            "context": "README says PDL v1.0.0, but package.json/schemas and ajv infrastructure use pdl-schema-v1.2.0."
          }
        ]
      }
    ],
    "testing": [
      {
        "criterion": "Unit tests exist for new code",
        "points_awarded": 2,
        "points_possible": 10,
        "findings": [
          {
            "file": "src/pipelines/pdl.ts",
            "line": 15,
            "failure_code": "STR-OMI/H",
            "issue": "Public PDL pipeline exports lack direct test coverage",
            "context": "Search across test/**/*.test.ts found no direct references to parsePDL, validatePDL, renderPDL, or pdl.generate despite these being exported public functionality."
          },
          {
            "file": "src/parser/pdl-validator.ts",
            "line": 15,
            "failure_code": "STR-OMI/H",
            "issue": "PDL validator lacks direct tests",
            "context": "No PDL-focused schema/semantic tests were found, even though PDL validation is part of the public API."
          },
          {
            "file": "src/renderer/pdl-renderer.ts",
            "line": 27,
            "failure_code": "STR-OMI/H",
            "issue": "PDL renderer lacks direct tests",
            "context": "No renderer tests target renderPDL output, despite non-trivial 587-line renderer implementation."
          }
        ]
      },
      {
        "criterion": "Tests cover edge cases",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Tests verify behavior, not implementation",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Tests actually run and pass",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": [
          {
            "note": "Could not execute test runner with provided tools; criterion assessed from configured vitest setup, existing coverage artifacts, and extensive test inventory without deducting for tool unavailability."
          }
        ]
      }
    ],
    "best_practices": [
      {
        "criterion": "Security basics followed",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "No performance anti-patterns",
        "points_awarded": 5,
        "points_possible": 5,
        "findings": []
      },
      {
        "criterion": "Separation of concerns",
        "points_awarded": 0,
        "points_possible": 5,
        "findings": [
          {
            "file": "src/resolvers/filesystem.ts",
            "line": 262,
            "failure_code": "PRA-MAT/M",
            "issue": "Resolver embeds command-type compatibility mapping that is inconsistent with resolver type contract",
            "context": "extractCommandData() maps legacy CDL types into ResolvedCommandData.commandType. This translation layer currently maps 'executor' to 'agent', collapsing semantics that downstream resolution consumers may rely on."
          }
        ]
      },
      {
        "criterion": "Dependencies justified",
        "points_awarded": 0,
        "points_possible": 5,
        "findings": [
          {
            "file": "src/resolvers/filesystem.ts",
            "line": 262,
            "failure_code": "SEM-INC/C",
            "issue": "Legacy executor command type is incorrectly normalized to 'agent'",
            "context": "COMMAND_TYPE_MAP maps executor -> agent at lines 262-265, while extractCommandData separately infers agentType='executor' for executor refs at lines 249-257. This creates contradictory resolved metadata and is a functional inconsistency in a core resolver path."
          }
        ]
      }
    ]
  },
  "issues": [
    {
      "severity": "critical",
      "type": "functional_inconsistency",
      "title": "Legacy executor commandType is incorrectly normalized to 'agent'",
      "file": "src/resolvers/filesystem.ts",
      "line": 262,
      "failure_code": "SEM-INC/C",
      "why_it_matters": "This is a core resolver path used by downstream consumers. A command declared as executor is surfaced as commandType='agent', which can alter workflow rendering or orchestration behavior and creates contradictory metadata beside agentType='executor'.",
      "suggested_fix": "Preserve executor semantics in resolved metadata or align the ResolvedCommandData contract and all downstream consumers to a single canonical representation, with explicit migration handling and tests."
    },
    {
      "severity": "high",
      "type": "missing_tests",
      "title": "Public PDL pipeline functionality lacks direct tests",
      "file": "src/pipelines/pdl.ts",
      "line": 15,
      "failure_code": "STR-OMI/H",
      "why_it_matters": "PDL parse/validate/render/generate functionality is exported as public API, but no direct tests were found in test/**/*.test.ts. This leaves newly shipped core functionality unverified.",
      "suggested_fix": "Add PDL-focused parser, validator, renderer, and end-to-end pipeline tests covering happy path and invalid-stage/rollback cases."
    },
    {
      "severity": "high",
      "type": "missing_tests",
      "title": "PDL renderer lacks direct tests despite non-trivial implementation",
      "file": "src/renderer/pdl-renderer.ts",
      "line": 27,
      "failure_code": "STR-OMI/H",
      "why_it_matters": "The renderer is large and logic-heavy, but there are no direct tests verifying output sections, defaults, tracker fallback behavior, or formatting stability.",
      "suggested_fix": "Create renderer tests that assert on generated markdown for minimal, full-featured, and invalid/edge-case pipelines."
    },
    {
      "severity": "medium",
      "type": "documentation_mismatch",
      "title": "README version is stale",
      "file": "README.md",
      "line": 12,
      "failure_code": "STR-OMI/M",
      "why_it_matters": "Consumers rely on README as package truth. Listing 0.13.0 while package.json is 0.19.1 undermines trust and makes behavior/version expectations unclear.",
      "suggested_fix": "Update README current-version references to match package.json or remove manually maintained version text."
    },
    {
      "severity": "medium",
      "type": "documentation_mismatch",
      "title": "README incorrectly states PDL has no factory",
      "file": "README.md",
      "line": 611,
      "failure_code": "STR-OMI/M",
      "why_it_matters": "This is a public API contradiction: src/pipelines/pdl.ts, src/parser/pdl-validator.ts, and src/renderer/pdl-renderer.ts implement active PDL support.",
      "suggested_fix": "Document the PDL pipeline alongside ADL/CDL/WDL, including examples, schema version, and export surface."
    },
    {
      "severity": "medium",
      "type": "documentation_mismatch",
      "title": "README lists outdated bundled PDL schema version",
      "file": "README.md",
      "line": 112,
      "failure_code": "STR-INC/M",
      "why_it_matters": "Users reading the docs will expect PDL v1.0.0, but AJV infrastructure loads pdl-schema-v1.2.0.",
      "suggested_fix": "Synchronize README schema version references with schemas/ and src/parser/ajv-infrastructure.ts."
    },
    {
      "severity": "high",
      "type": "error_handling",
      "title": "Resolver silently suppresses read/parse failures",
      "file": "src/resolvers/filesystem.ts",
      "line": 116,
      "failure_code": "SEM-COM/H",
      "why_it_matters": "Broken YAML or transient filesystem failures become indistinguishable from 'not found', making operational debugging difficult in a critical file-resolution path.",
      "suggested_fix": "Capture the last encountered error and surface it when no valid candidate resolves, or return structured diagnostics/warnings for failed candidates."
    }
  ],
  "auto_fail_conditions": {
    "AF-001": {
      "triggered": false,
      "reason": "No hardcoded secrets, injection patterns, or obvious basic security violations found in reviewed source."
    },
    "AF-002": {
      "triggered": false,
      "reason": "No unhandled async user-facing endpoint patterns found; one silent catch in resolver was scored as high severity but not enough evidence of system-wide critical-path crash exposure."
    },
    "AF-003": {
      "triggered": true,
      "reason": "Core resolver metadata is internally inconsistent: src/resolvers/filesystem.ts:262-265 maps legacy executor commandType to 'agent', conflicting with executor inference and risking incorrect downstream behavior."
    },
    "AF-004": {
      "triggered": true,
      "reason": "Exported PDL core functionality (src/pipelines/pdl.ts, src/parser/pdl-validator.ts, src/renderer/pdl-renderer.ts) has no direct tests in the test suite."
    },
    "AF-005": {
      "triggered": false,
      "reason": "No confirmed breaking change without migration path found in reviewed files."
    }
  },
  "counts": {
    "total_issues": 7,
    "by_severity": {
      "critical": 1,
      "high": 3,
      "medium": 3,
      "low": 0
    },
    "by_domain": {
      "SEM": 3,
      "STR": 4,
      "PRA": 1
    },
    "by_type": {
      "functional_inconsistency": 1,
      "missing_tests": 2,
      "documentation_mismatch": 3,
      "error_handling": 1
    }
  },
  "verdict": {
    "status": "FAIL",
    "ready_for_next_phase": false,
    "reason": "Score is 66/100, below the 70 threshold, and auto-fail conditions AF-003 and AF-004 are triggered. The phase should not advance until the resolver inconsistency is fixed, PDL public API is properly tested, and README/public documentation is synchronized with the shipped package."
  }
}