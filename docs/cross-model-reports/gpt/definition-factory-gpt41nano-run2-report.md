{
  "score": 78,
  "criteria": {
    "code_quality": 22,
    "standards_compliance": 20,
    "testing": 20,
    "best_practices": 16
  },
  "issues": [
    {
      "severity": "M",
      "category": "Code Quality",
      "description": "Large functions exceeding 80 lines, e.g., src/transformer/wdl-context-builder.ts:458 (196 lines).",
      "failure_code": "PRA-FRA/M"
    },
    {
      "severity": "H",
      "category": "Code Quality",
      "description": "Some functions have nesting depth approaching 4, e.g., src/adl-validator.ts:99.",
      "failure_code": "PRA-FRA/H"
    },
    {
      "severity": "M",
      "category": "Standards Compliance",
      "description": "Some files lack consistent formatting, e.g., inconsistent indentation in src/renderer/nunjucks-env.ts.",
      "failure_code": "STR-INC/M"
    },
    {
      "severity": "H",
      "category": "Standards Compliance",
      "description": "Missing JSDoc comments on exported functions in src/index.ts.",
      "failure_code": "STR-OMI/H"
    },
    {
      "severity": "M",
      "category": "Testing",
      "description": "Most test files have comprehensive coverage, but some edge cases are not tested, e.g., null inputs in parser/error-mapping.ts.",
      "failure_code": "SEM-COM/M"
    },
    {
      "severity": "L",
      "category": "Testing",
      "description": "Some tests mock internal functions rather than testing behavior, e.g., pipelines/validation-integration.test.ts:211.",
      "failure_code": "EPI-GRN/L"
    },
    {
      "severity": "M",
      "category": "Best Practices",
      "description": "No hardcoded secrets detected, but some schema files are large and could benefit from validation optimization.",
      "failure_code": "SEM-INC/L"
    },
    {
      "severity": "M",
      "category": "Best Practices",
      "description": "Some functions could benefit from separation of concerns, e.g., large context builder functions.",
      "failure_code": "PRA-MAT/M"
    }
  ],
  "auto_fail_conditions": [
    {
      "condition": "Security vulnerabilities detected",
      "status": "Clear"
    },
    {
      "condition": "Missing error handling in critical paths",
      "status": "Clear"
    },
    {
      "condition": "Code does not function",
      "status": "Clear"
    },
    {
      "condition": "Missing tests for core functionality",
      "status": "Clear"
    },
    {
      "condition": "Breaking changes without migration path",
      "status": "Clear"
    }
  ],
  "decision": "✅ PASS - Ready for next phase",
  "reasoning": "The project demonstrates good overall code quality and testing coverage, with some room for improvement in function size, documentation, and test behavior. No critical issues detected, and the score exceeds the threshold of 70."
}