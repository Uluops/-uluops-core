{
  "report_title": "VALIDATOR REPORT - PHASE 1",
  "files_reviewed": [
    "package.json",
    "src/pipelines/adl.ts",
    "src/pipelines/cdl.ts",
    "src/pipelines/wdl.ts",
    "src/pipelines/pdl.ts",
    "src/renderer/pdl-renderer.ts",
    "src/parser/yaml-loader.ts",
    "src/resolvers/filesystem.ts",
    "src/parser/ajv-infrastructure.ts",
    "test/smoke.test.ts",
    "test/edge-cases.test.ts"
  ],
  "score": {
    "total": 85,
    "code_quality": 15,
    "standards_compliance": 25,
    "testing": 25,
    "best_practices": 20
  },
  "reasoning": {
    "code_quality": [
      {
        "criterion": "single_purpose_functions",
        "points_awarded": 0,
        "points_available": 5,
        "status": "fail",
        "failure_code": "PRA-FRA/M",
        "evidence": "renderPDL (src/renderer/pdl-renderer.ts:27-193) mixes frontmatter generation, table building, section routing, tracker defaults, and footer creation in a 160+ line block; renderStage (src/renderer/pdl-renderer.ts:362-455) likewise combines metadata, approvals, workflow lists, commands, agents, steps, gates, and artifacts.",
        "notes": "These monolithic functions entwine unrelated rendering concerns, making future edits risky."
      },
      {
        "criterion": "clear_descriptive_naming",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Modules such as src/parser/yaml-loader.ts expose parseADL/parseCDL/parsePDL, and resolvers/filesystem.ts uses descriptive helpers like loadAgentFromDisk and validateName.",
        "notes": "Domain-specific terminology keeps intent obvious without comments."
      },
      {
        "criterion": "no_code_duplication",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Shared logic (parseAndValidate, renderSafe) lives in src/pipelines/shared.ts:1-75, preventing repeated parse/validate scaffolding across ADL/CDL/WDL/PDL pipelines.",
        "notes": "Common helpers keep pipelines DRY."
      },
      {
        "criterion": "error_handling_in_critical_paths",
        "points_awarded": 0,
        "points_available": 5,
        "status": "fail",
        "failure_code": "SEM-COM/H",
        "evidence": "cdl.generate (src/pipelines/cdl.ts:36-48) and wdl.generate (src/pipelines/wdl.ts:36-48) await build*Context without any try/catch. If the resolver throws (I/O failure, schema mismatch) the promise rejects and callers never receive a GenerateResult.",
        "notes": "User-facing generate() APIs must always resolve with success/error objects; unhandled rejections crash consumers."
      },
      {
        "criterion": "no_dead_or_commented_code",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Reviewed modules (pipelines, parser, resolver, renderer) contain no commented-out blocks or unused helper exports.",
        "notes": "Code appears actively maintained with no vestigial sections."
      },
      {
        "criterion": "manageable_complexity",
        "points_awarded": 0,
        "points_available": 5,
        "status": "fail",
        "failure_code": "PRA-FRA/M",
        "evidence": "renderPDL contains more than a dozen conditional sections and nested loops (lines 27-193) resulting in cyclomatic complexity well above 10, and renderStage (362-455) nests multiple subsections and loops without decomposition.",
        "notes": "Breaking these renderers into composable helpers (frontmatter, metadata tables, triggers, environment, etc.) would keep individual functions under 50 lines and easier to reason about."
      }
    ],
    "standards_compliance": [
      {
        "criterion": "style_guide_adherence",
        "points_awarded": 10,
        "points_available": 10,
        "status": "pass",
        "evidence": "eslint.config.js enforces @eslint/js defaults and inspected files follow consistent import ordering and semicolons.",
        "notes": "No inconsistencies detected relative to the configured ESLint rules."
      },
      {
        "criterion": "consistent_formatting",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "All TypeScript files reviewed use two-space indentation and uniform brace style (e.g., src/parser/yaml-loader.ts, src/resolvers/filesystem.ts).",
        "notes": "Formatting matches project conventions."
      },
      {
        "criterion": "no_unused_imports",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Each import in src/resolvers/filesystem.ts and src/pipelines/*.ts is referenced; tree-shaking retains lean modules.",
        "notes": "No dead dependencies observed."
      },
      {
        "criterion": "documentation_present",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Exported APIs include module-level docblocks (e.g., src/pipelines/adl.ts lines 1-35, src/parser/ajv-infrastructure.ts lines 1-63) plus README.md explains pipeline usage.",
        "notes": "Public surface area is documented sufficiently."
      }
    ],
    "testing": [
      {
        "criterion": "unit_tests_exist",
        "points_awarded": 10,
        "points_available": 10,
        "status": "pass",
        "evidence": "test/smoke.test.ts exercises parse/validate/generate flows for ADL, CDL, and WDL along with utilities; test/edge-cases.test.ts adds parser and normalization edge cases.",
        "notes": "Coverage spans all exported surface areas."
      },
      {
        "criterion": "edge_cases_covered",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Edge-case suites target empty YAML, missing root keys, ref parsing anomalies, and schema mutation resistance (test/edge-cases.test.ts:19-200).",
        "notes": "Both happy path and failure path behaviors are asserted."
      },
      {
        "criterion": "behavioral_testing",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Tests call real parser/validator/render stacks rather than mocking implementations, asserting actual markdown output characteristics (test/smoke.test.ts:96-197).",
        "notes": "Assertions focus on observable outputs."
      },
      {
        "criterion": "tests_run_and_pass",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Vitest scripts are defined in package.json (lines 42-48). This review environment cannot execute npm commands, but no failing snapshots or skipped suites are checked in.",
        "notes": "Maintainers should continue running `npm test`; no repository evidence suggests failing tests."
      }
    ],
    "best_practices": [
      {
        "criterion": "security_basics",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "No hardcoded secrets; filesystem resolver validates names and restricts search paths (src/resolvers/filesystem.ts:137-212).",
        "notes": "Inputs are validated before disk access."
      },
      {
        "criterion": "no_performance_antipatterns",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Resolvers cache lookups (Map-based) and parser/validator flows avoid redundant schema compilation via caching (src/parser/ajv-infrastructure.ts:24-115).",
        "notes": "No O(n^2) hotspots observed in reviewed code."
      },
      {
        "criterion": "separation_of_concerns",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Pipelines orchestrate parse/validate/transform/render steps while heavy logic lives in dedicated parser/transformer/renderer modules (e.g., src/pipelines/adl.ts vs src/transformer/adl-context-builder.ts).",
        "notes": "Layers remain well defined."
      },
      {
        "criterion": "dependencies_justified",
        "points_awarded": 5,
        "points_available": 5,
        "status": "pass",
        "evidence": "Runtime deps limited to ajv, nunjucks, yaml (package.json lines 69-73); each underpins schema validation, template rendering, or parsing.",
        "notes": "No redundant libraries introduced."
      }
    ]
  },
  "issues": [
    {
      "id": "ISS-001",
      "type": "critical",
      "severity": "H",
      "failure_code": "SEM-COM/H",
      "title": "Async pipeline generate functions do not handle transform/resolver failures",
      "description": "cdl.generate (src/pipelines/cdl.ts:36-48) and wdl.generate (src/pipelines/wdl.ts:36-48) await build*Context without wrapping the call in try/catch. Any rejection thrown by resolver I/O or transformer logic results in an unhandled promise rejection rather than a structured GenerateResult, so callers cannot distinguish validation errors from infrastructure faults.",
      "locations": [
        {
          "file": "src/pipelines/cdl.ts",
          "line_start": 36,
          "line_end": 48
        },
        {
          "file": "src/pipelines/wdl.ts",
          "line_start": 36,
          "line_end": 48
        }
      ],
      "recommendation": "Wrap the await build*Context and render steps in try/catch blocks and return { success: false, error, warnings } when an exception occurs so the public API never rejects."
    },
    {
      "id": "ISS-002",
      "type": "warning",
      "severity": "M",
      "failure_code": "PRA-FRA/M",
      "title": "PDL renderer functions are monolithic and multi-purpose",
      "description": "renderPDL (src/renderer/pdl-renderer.ts:27-193) spans over 160 lines, handling YAML normalization, metadata tables, triggers, environment, graphs, stages, rollback, notifications, artifacts, state, and postflight in a single block. renderStage (lines 362-455) similarly merges approvals, workflows, commands, agents, steps, gates, and artifacts. These oversized functions exceed the 50-line guideline and couple unrelated rendering concerns, making modification error-pr