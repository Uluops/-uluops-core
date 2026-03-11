{
  "summary": {
    "score": 97,
    "decision": "PASS"
  },
  "category_scores": {
    "code_quality": 30,
    "standards_compliance": 22,
    "testing": 25,
    "best_practices": 20
  },
  "files_reviewed": [
    "package.json",
    "src/index.ts",
    "src/client.ts",
    "src/http/http-client.ts",
    "src/config/constants.ts",
    "src/config/loaders.ts",
    "src/config/validators.ts",
    "src/operations/auth.ts",
    "src/operations/projects.ts",
    "src/operations/runs.ts",
    "src/operations/issues.ts",
    "src/operations/analytics.ts",
    "src/operations/admin.ts",
    "test/client.test.ts",
    "test/operations/projects.test.ts"
  ],
  "issues": [
    {
      "failure_code": "SEM-INC/M",
      "severity": "M",
      "domain": "SEM",
      "type": "INC",
      "file": "src/config/constants.ts",
      "line": 59,
      "title": "SDK version constant out of sync with package version",
      "description": "SDK_VERSION is hardcoded to \"0.1.6\" while package.json declares version \"0.2.0\". This breaks the documented requirement to keep them aligned and causes incorrect user agent metadata to be sent with requests.",
      "recommendation": "Update SDK_VERSION to match the current package.json version (0.2.0) and ensure the constant is updated with every release."
    }
  ],
  "total_issues": 1,
  "by_severity": {
    "C": 0,
    "H": 0,
    "M": 1,
    "L": 0,
    "I": 0
  },
  "by_domain": {
    "SEM": 1
  },
  "by_type": {
    "INC": 1
  },
  "auto_fail": {
    "AF-001": "clear",
    "AF-002": "clear",
    "AF-003": "clear",
    "AF-004": "clear",
    "AF-005": "clear"
  },
  "report": "🔍 VALIDATOR REPORT - PHASE ?\n\nFiles Reviewed:\n- package.json\n- src/index.ts\n- src/client.ts\n- src/http/http-client.ts\n- src/config/constants.ts\n- src/config/loaders.ts\n- src/config/validators.ts\n- src/operations/auth.ts\n- src/operations/projects.ts\n- src/operations/runs.ts\n- src/operations/issues.ts\n- src/operations/analytics.ts\n- src/operations/admin.ts\n- test/client.test.ts\n- test/operations/projects.test.ts\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nVALIDATION RESULTS\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📊 Score: 97/100\n\nCode Quality:      30/30\nStandards Compliance:22/25\nTesting:           25/25\nBest Practices:    20/20\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nREASONING TRACE\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n**Code Quality** (30/30):\n- All inspected modules expose focused wrapper functions with clear responsibilities and comprehensive typings. No excessive complexity or duplication observed.\n\n**Standards Compliance** (22/25):\n- Follows project style: -3 pts  \n  Evidence: src/config/constants.ts:59 hardcodes SDK_VERSION as \"0.1.6\" while package.json lists \"0.2.0\", contradicting the inline comment to keep them in sync. This inconsistency ships incorrect metadata.  \n  Context: Accurate versioning is part of the project’s documented standard for HTTP headers and diagnostic logging.\n\n**Testing** (25/25):\n- Extensive Vitest suites cover OpsClient flows, HTTP client behavior, and operations modules with contract validation using nock; no uncovered critical paths identified.\n\n**Best Practices** (20/20):\n- Security-sensitive values sourced from env or config, HTTP helpers sanitize inputs, and responsibilities are cleanly separated between client, operations, and config layers.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nISSUES FOUND\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n🟡 WARNINGS (Should Fix):\n- SDK version constant out of sync with package version: src/config/constants.ts:59 [SEM-INC/M]  \n  SDK_VERSION remains at \"0.1.6\" while package.json is \"0.2.0\", violating the documented requirement to keep the values aligned and emitting incorrect user agent metadata.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nAUTO-FAIL CONDITIONS\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAF-001 Security vulnerabilities detected: ✅ Clear\nAF-002 Missing error handling in critical paths: ✅ Clear\nAF-003 Code does not function: ✅ Clear\nAF-004 Missing tests for core functionality: ✅ Clear\nAF-005 Breaking changes without migration path: ✅ Clear\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nDECISION\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n✅ PASS - Ready for next phase\n\nReasoning: Overall score 97 ≥ 70 with no critical issues. The only finding is a medium-severity version inconsistency that should be corrected, but it does not block progression."
}