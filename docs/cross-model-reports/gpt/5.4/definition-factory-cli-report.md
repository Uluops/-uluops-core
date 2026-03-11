{
  "phase": "standalone",
  "decision": "FAIL",
  "score": 88,
  "summary": "The TypeScript CLI package is generally well-structured, documented in code, and has a broad automated test suite covering CLI behavior and utility modules. However, the implementation is not fully aligned with its public documentation: PDL/pipeline support is implemented in code and tests but omitted from the README command/type-detection documentation, and one exported/public-facing type definition remains inconsistent with implemented support. These are not runtime-breaking defects, but they are standards/documentation inconsistencies significant enough to block progression under this validator’s strict gate because public API/behavior changed without complete documentation alignment.",
  "files_reviewed": [
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    "README.md",
    "CHANGELOG.md",
    "src/cli.ts",
    "src/types.ts",
    "src/commands/generate.ts",
    "src/commands/validate.ts",
    "src/utils/detect.ts",
    "src/utils/files.ts",
    "src/utils/format.ts",
    "test/setup.ts",
    "test/helpers.ts",
    "test/cli.test.ts",
    "test/commands/generate.test.ts",
    "test/commands/validate.test.ts",
    "test/utils/detect.test.ts",
    "test/utils/files.test.ts",
    "test/utils/format.test.ts",
    "test/fixtures/trigger-rejection.mjs"
  ],
  "validation_results": {
    "code_quality": {
      "score": 28,
      "out_of": 30,
      "findings": [
        {
          "criterion": "No dead/commented code",
          "points_lost": 2,
          "failure_code": "STR-EXC/L",
          "evidence": [
            "src/utils/files.ts:76",
            "src/utils/files.ts:94",
            "src/utils/files.ts:108"
          ],
          "context": "defaultOutputPath(), isFile(), and definitionName() are exported but not referenced anywhere in src/**/*.ts. Some are only exercised from tests, which suggests public surface area exceeds the package's current production usage and increases maintenance burden."
        }
      ]
    },
    "standards_compliance": {
      "score": 18,
      "out_of": 25,
      "findings": [
        {
          "criterion": "Documentation present",
          "points_lost": 5,
          "failure_code": "STR-OMI/M",
          "evidence": [
            "README.md:3",
            "README.md:134",
            "README.md:145",
            "src/cli.ts:36",
            "src/cli.ts:38",
            "src/utils/detect.ts:13",
            "CHANGELOG.md:12"
          ],
          "context": "The README still describes only ADL/CDL/WDL support and documents `--type` as `adl|cdl|wdl`, while the CLI help text, type detection, and changelog show PDL/pipeline support is now implemented. Public-facing behavior changed but the main package documentation was not updated consistently."
        },
        {
          "criterion": "Follows project style guide",
          "points_lost": 2,
          "failure_code": "STR-INC/M",
          "evidence": [
            "src/types.ts:5",
            "src/cli.ts:38",
            "src/commands/generate.ts:53",
            "src/commands/validate.ts:41"
          ],
          "context": "GlobalOptions.type excludes 'pdl' even though the CLI accepts `--type pdl` and runtime messages advertise it. This creates an internal consistency/style mismatch between declared types and implemented interface."
        }
      ]
    },
    "testing": {
      "score": 25,
      "out_of": 25,
      "findings": []
    },
    "best_practices": {
      "score": 17,
      "out_of": 20,
      "findings": [
        {
          "criterion": "Separation of concerns",
          "points_lost": 3,
          "failure_code": "PRA-MAT/M",
          "evidence": [
            "src/commands/generate.ts:40-45",
            "src/commands/generate.ts:53-55",
            "src/commands/generate.ts:72",
            "src/commands/generate.ts:83",
            "src/commands/generate.ts:124",
            "src/commands/generate.ts:166",
            "src/commands/validate.ts:28-33",
            "src/commands/validate.ts:41-42",
            "src/commands/validate.ts:58",
            "src/commands/validate.ts:67",
            "src/commands/validate.ts:89",
            "src/commands/validate.ts:132"
          ],
          "context": "Business logic helpers directly call process.exit() deep inside command workflows. This tightly couples domain/control-flow logic to process lifecycle, making reuse and unit isolation harder than returning status codes or throwing command-level errors."
        }
      ]
    }
  },
  "reasoning_trace": {
    "code_quality": [
      {
        "criterion": "Functions are single-purpose",
        "result": "pass",
        "evidence": [
          "src/commands/generate.ts:50-109",
          "src/commands/generate.ts:111-168",
          "src/commands/validate.ts:38-91",
          "src/utils/format.ts:9-112"
        ],
        "notes": "Functions are generally focused. The larger command functions remain below the 50-line threshold or close to it and maintain coherent responsibilities."
      },
      {
        "criterion": "Clear, descriptive naming",
        "result": "pass",
        "evidence": [
          "src/utils/detect.ts:9",
          "src/utils/files.ts:12",
          "src/utils/format.ts:46",
          "src/commands/generate.ts:15",
          "src/commands/validate.ts:12"
        ],
        "notes": "Naming is descriptive and domain-oriented."
      },
      {
        "criterion": "No code duplication",
        "result": "pass",
        "evidence": [
          "src/commands/generate.ts",
          "src/commands/validate.ts"
        ],
        "notes": "There is some parallel structure between generate/validate commands, but not enough duplicated block content to justify a deduction."
      },
      {
        "criterion": "Error handling in critical paths",
        "result": "pass",
        "evidence": [
          "src/cli.ts:11-18",
          "src/commands/generate.ts:33-46",
          "src/commands/generate.ts:61-73",
          "src/commands/validate.ts:21-34",
          "src/commands/validate.ts:47-59"
        ],
        "notes": "Async file operations and command entrypoints have explicit error handling and user-friendly error messages."
      },
      {
        "criterion": "No dead/commented code",
        "result": "partial",
        "evidence": [
          "src/utils/files.ts:76",
          "src/utils/files.ts:94",
          "src/utils/files.ts:108"
        ],
        "notes": "No harmful commented-out blocks were found, but several exported helpers appear unused by production code."
      },
      {
        "criterion": "Complexity is manageable",
        "result": "pass",
        "evidence": [
          "src/commands/generate.ts:15-47",
          "src/commands/validate.ts:12-35",
          "src/utils/detect.ts:23-44"
        ],
        "notes": "Nesting depth and branching remain manageable."
      }
    ],
    "standards_compliance": [
      {
        "criterion": "Follows project style guide",
        "result": "partial",
        "evidence": [
          "src/types.ts:5",
          "src/cli.ts:38"
        ],
        "notes": "Manual inspection only; no linter script is configured in package.json. Internal type declarations do not fully reflect actual CLI capabilities."
      },
      {
        "criterion": "Consistent formatting",
        "result": "pass",
        "evidence": [
          "src/cli.ts",
          "src/commands/generate.ts",
          "src/commands/validate.ts",
          "src/utils/*.ts"
        ],
        "notes": "Formatting is consistent across the project."
      },
      {
        "criterion": "No unused imports/dependencies",
        "result": "pass",
        "evidence": [
          "package.json:38-47",
          "src/**/*.ts"
        ],
        "notes": "No unused imports were evident in reviewed files. Dependencies appear justified for the CLI package."
      },
      {
        "criterion": "Documentation present",
        "result": "fail",
        "evidence": [
          "README.md:3",
          "README.md:134",
          "README.md:145",
          "src/cli.ts:36-38",
          "src/utils/detect.ts:9-14",
          "CHANGELOG.md:12-15"
        ],
        "notes": "README does not reflect implemented PDL support despite public CLI/interface changes."
      }
    ],
    "testing": [
      {
        "criterion": "Unit tests exist for new code",
        "result": "pass",
        "evidence": [
          "test/commands/generate.test.ts",
          "test/commands/validate.test.ts",
          "test/utils/detect.test.ts",
          "test/utils/files.test.ts",
          "test/utils/format.test.ts",
          "test/cli.test.ts"
        ],
        "notes": "New commands and utility modules have corresponding tests."
      },
      {
        "criterion": "Tests cover edge cases",
        "result": "pass",
        "evidence": [
          "test/commands/generate.test.ts:52-62",
          "test/commands/generate.test.ts:117-144",
          "test/commands/generate.test.ts:207-244",
          "test/commands/validate.test.ts:14-38",
          "test/utils/files.test.ts:42-71",
          "test/utils/format.test.ts:131-140"
        ],
        "notes": "Missing files, invalid types, invalid definitions, empty directories, unreadable directories, and null/undefined formatting cases are covered."
      },
      {
        "criterion": "Tests verify behavior, not implementation",
        "result": "pass",
        "evidence": [
          "test/commands/generate.test.ts",
          "test/commands/validate.test.ts",
          "test/utils/*.test.ts"
        ],
        "notes": "Tests assert on output/exit behavior. No evidence of mocking the functions under test."
      },
      {
        "criterion": "Tests actually run and pass",
        "result": "assumed-pass-with-manual-evidence",
        "evidence": [
          "package.json:16-18",
          "vitest.config.ts:3-15",
          "test/**/*.test.ts"
        ],
        "notes": "A runnable Vitest setup is present. No shell execution tool was available in this environment, so execution could not be directly verified; manual review found no obvious syntax/config issues."
      }
    ],
    "best_practices": [
      {
        "criterion": "Security basics followed",
        "result": "pass",
        "evidence": [
          "src/**/*.ts"
        ],
        "notes": "No hardcoded secrets, SQL construction, or command injection patterns were found in reviewed code."
      },
      {
        "criterion": "No performance anti-patterns",
        "result": "pass",
        "evidence": [
          "src/utils/files.ts:18-37",
          "src/commands/generate.ts:130-160",
          "src/commands/validate.ts:106-126"
        ],
        "notes": "Directory scan and batch operations are straightforward; no obvious pathological complexity in this small CLI."
      },
      {
        "criterion": "Separation of concerns",
        "result": "partial",
        "evidence": [
          "src/commands/generate.ts:40-45",
          "src/commands/generate.ts:53-55",
          "src/commands/validate.ts:28-33",
          "src/commands/validate.ts:88-90"
        ],
        "notes": "Process termination is embedded in lower-level command helpers rather than being centralized at the command boundary."
      },
      {
        "criterion": "Dependencies justified",
        "result": "pass",
        "evidence": [
          "package.json:38-47"
        ],
        "notes": "Commander, TypeScript, tsx, Vitest, and coverage tooling are appropriate for this package."
      }
    ]
  },
  "issues": [
    {
      "severity": "medium",
      "type": "documentation",
      "title": "README omits implemented PDL support and misdocuments accepted --type values",
      "failure_code": "STR-OMI/M",
      "evidence": [
        "README.md:3",
        "README.md:134",
        "README.md:145",
        "src/cli.ts:36-38",
        "src/utils/detect.ts:13",
        "CHANGELOG.md:12-15"
      ],
      "explanation": "Public documentation still states the CLI supports ADL, CDL, and WDL only, and documents `--type` as `adl|cdl|wdl`. The implementation and changelog clearly include PDL/pipeline support. This creates user-facing inconsistency for a public CLI surface.",
      "suggestion": "Update README command descriptions, global options, type detection tables, and examples to include PDL/pipeline support wherever applicable."
    },
    {
      "severity": "medium",
      "type": "standards",
      "title": "GlobalOptions.type does not include 'pdl' although the CLI supports it",
      "failure_code": "STR-INC/M",
      "evidence": [
        "src/types.ts:5",
        "src/cli.ts:38",
        "src/commands/generate.ts:53",
        "src/commands/validate.ts:41"
      ],
      "explanation": "The shared options type advertises only `'adl' | 'cdl' | 'wdl'`, but runtime behavior and messages accept `pdl`. This is an internal contract mismatch that can confuse maintainers and consumers of typed command code.",
      "suggestion": "Extend GlobalOptions.type to include 'pdl' and ensure related docs/comments remain synchronized."
    },
    {
      "severity": "medium",
      "type": "architecture",
      "title": "Command helpers are tightly coupled to process.exit()",
      "failure_code": "PRA-MAT/M",
      "evidence": [
        "src/commands/generate.ts:40-45",
        "src/commands/generate.ts:53-55",
        "src/commands/generate.ts:72",
        "src/commands/generate.ts:83",
        "src/commands/generate.ts:124",
        "src/commands/generate.ts:166",
        "src/commands/validate.ts:28-33",
        "src/commands/validate.ts:41-42",
        "src/commands/validate.ts:58",
        "src/commands/validate.ts:67",
        "src/commands/validate.ts:89",
        "src/commands/validate.ts:132"
      ],
      "explanation": "Deep command helpers terminate the process directly instead of returning status or throwing controlled errors. This reduces reuse and makes isolation/unit testing harder.",
      "suggestion": "Return status objects or throw typed errors from helpers and let the top-level command action decide exit behavior."
    },
    {
      "severity": "low",
      "type": "maintainability",
      "title": "Some exported utility functions appear unused in production code",
      "failure_code": "STR-EXC/L",
      "evidence": [
        "src/utils/files.ts:76",
        "src/utils/files.ts:94",
        "src/utils/files.ts:108"
      ],
      "explanation": "defaultOutputPath(), isFile(), and definitionName() are exported but not referenced by the package source. Unused exported surface area increases maintenance cost and can mislead future contributors.",
      "suggestion": "Remove unused exports or integrate them into production flows if they are intended parts of the package API."
    }
  ],
  "auto_fail_conditions": {
    "AF-001": {
      "status": "clear",
      "triggered": false,
      "reason": "No critical security-basics violations found."
    },
    "AF-002": {
      "status": "clear",
      "triggered": false,
      "reason": "Critical async/user-facing paths include error handling."
    },
    "AF-003": {
      "status": "clear",
      "triggered": false,
      "reason": "No evidence of non-functional code from static inspection."
    },
    "AF-004": {
      "status": "clear",
      "triggered": false,
      "reason": "Core functionality has corresponding tests in commands/, utils/, and cli test suites."
    },
    "AF-005": {
      "status": "triggered",
      "triggered": true,
      "reason": "Public behavior expanded to include PDL support, but primary user documentation (README) was not updated consistently, leaving an incomplete migration/discovery path for consumers."
    }
  },
  "counts": {
    "total_issues": 4,
    "by_severity": {
      "critical": 0,
      "high": 0,
      "medium": 3,
      "low": 1
    },
    "by_domain": {
      "SEM": 0,
      "STR": 3,
      "PRA": 1,
      "EPI": 0
    },
    "by_type": {
      "documentation": 1,
      "standards": 1,
      "architecture": 1,
      "maintainability": 1
    }
  },
  "decision_reasoning": "Score is 88/100, which would normally pass, and no critical/high defects were found in implementation quality. However, this validator fails the phase because AF-005 is triggered: the package's public CLI behavior now includes PDL support, but the README remains materially inconsistent with the implementation and changelog. For a CLI package, incomplete public documentation for changed behavior is a release-blocking standards issue."
}