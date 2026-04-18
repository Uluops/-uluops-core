{
  "criteria": {
    "Code Quality": 20,
    "Standards Compliance": 18,
    "Testing": 15,
    "Best Practices": 12
  },
  "total_score": 65,
  "issues": [
    {
      "severity": "CRITICAL",
      "count": 2,
      "issues": [
        {
          "description": "Missing null check before property access",
          "file": "src/index.ts",
          "line": 96,
          "failure_code": "SEM-COM/H"
        },
        {
          "description": "Large function exceeds 80 lines",
          "file": "test/smoke.test.ts",
          "line": 328,
          "failure_code": "PRA-FRA/M"
        }
      ]
    },
    {
      "severity": "WARNING",
      "count": 3,
      "issues": [
        {
          "description": "Test mocks the function under test",
          "file": "test/edge-cases.test.ts",
          "line": 481,
          "failure_code": "EPI-GRN/M"
        },
        {
          "description": "No tests for some modules",
          "file": "src/index.ts",
          "line": 96,
          "failure_code": "STR-OMI/M"
        },
        {
          "description": "Missing JSDoc comments",
          "file": "src/index.ts",
          "line": 96,
          "failure_code": "STR-OMI/L"
        }
      ]
    }
  ],
  "auto_fail_conditions": [
    {
      "code": "AF-001",
      "status": "Clear"
    },
    {
      "code": "AF-002",
      "status": "Clear"
    },
    {
      "code": "AF-003",
      "status": "Clear"
    },
    {
      "code": "AF-004",
      "status": "Clear"
    },
    {
      "code": "AF-005",
      "status": "Clear"
    }
  ],
  "decision": "FAIL",
  "reason": "The codebase has critical issues such as missing null checks and overly large functions, and the overall score is below the passing threshold of 70. These issues pose runtime risks and hinder maintainability. Immediate fixes are required before proceeding."
}