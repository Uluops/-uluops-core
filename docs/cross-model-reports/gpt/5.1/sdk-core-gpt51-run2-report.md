{
  "score": {
    "total": 96,
    "code_quality": 29,
    "standards_compliance": 24,
    "testing": 25,
    "best_practices": 18
  },
  "issues": {
    "total_issues": 5,
    "by_severity": {
      "C": 0,
      "H": 0,
      "M": 3,
      "L": 2,
      "I": 0
    },
    "by_domain": {
      "PRA": 2,
      "SEM": 2,
      "STR": 1,
      "EPI": 0
    },
    "by_type": {
      "single_purpose_functions": 1,
      "clear_naming": 0,
      "no_duplication": 0,
      "error_handling": 0,
      "no_dead_code": 0,
      "complexity": 1,
      "style_guide": 0,
      "formatting": 1,
      "no_unused_deps": 0,
      "documentation": 2,
      "unit_tests": 0,
      "edge_cases": 0,
      "behavioral_tests": 0,
      "tests_run": 0,
      "security_basics": 0,
      "performance": 0,
      "separation_of_concerns": 1,
      "dependencies_justified": 0
    },
    "items": [
      {
        "type": "single_purpose_functions",
        "file": "src/http/http-client.ts",
        "line": 102,
        "severity": "M",
        "failure_code": "PRA-FRA/M",
        "title": "HttpClient class is quite large and multi-responsibility",
        "description": "The HttpClient class (src/http/http-client.ts:102) centralizes configuration, auth strategy wiring, envelope parsing, retry logic, rate limiting, raw/binary accessors, and error mapping in a single class of ~700+ lines. While methods are individually focused, the aggregate responsibility of the class is broad and makes it harder to navigate and modify.",
        "suggestion": "Consider extracting clearly separable concerns into helper classes or modules: e.g., (1) URL/query construction, (2) backoff and retry calculation, (3) error mapping and rate-limit extraction, or (4) raw/binary fetch primitives. This would keep HttpClient focused on orchestrating requests rather than implementing all low-level behaviors directly."
      },
      {
        "type": "complexity",
        "file": "src/config/constants.ts",
        "line": 15,
        "severity": "M",
        "failure_code": "PRA-FRA/M",
        "title": "SDK_CORE_VERSION constant out of sync with package.json version",
        "description": "SDK_CORE_VERSION in src/config/constants.ts is '0.1.1' (line 15), while package.json declares version '0.1.2' (package.json:3). This creates a divergence between the runtime constant and the published package version.",
        "suggestion": "Update SDK_CORE_VERSION to match the package.json version, or introduce a lightweight build-time step to keep them synchronized. Divergent versions can confuse consumers and break diagnostics that rely on that constant."
      },
      {
        "type": "formatting",
        "file": "src/utils/logger.ts",
        "line": 41,
        "severity": "L",
        "failure_code": "STR-INC/L",
        "title": "Minor style inconsistency in arrow function formatting",
        "description": "In sanitizeForLog (src/utils/logger.ts:40–42), the arrow function uses an implicit return without parentheses around the argument (`value.map(item => sanitizeForLog(item, seen));`). Elsewhere, arguments often use parentheses, and the rest of the codebase is highly consistent. This is a minor style nit but stands out in an otherwise very uniform codebase.",
        "suggestion": "Align with the predominant style by using `value.map((item) => sanitizeForLog(item, seen));` or ensure the project’s formatter is consistently applied. This keeps the codebase visually uniform."
      },
      {
        "type": "documentation",
        "file": "src/config/loaders.ts",
        "line": 188,
        "severity": "M",
        "failure_code": "STR-OMI/M",
        "title": "validateCredentials public behavior not surfaced in README",
        "description": "validateCredentials (src/config/loaders.ts:319–331) is a public export (src/index.ts:43–53) and enforces important behavior (throwing ValidationError when no credentials or inconsistent email/password are provided). README.md explains the credential chain and env vars but does not explicitly document validateCredentials, which could be used by SDKs or apps to pre-validate configs.",
        "suggestion": "Add a short subsection in the README “Configuration” section documenting validateCredentials(), its error type (ValidationError), and when callers should use it (e.g., CLI startup). This makes this behavior discoverable for consumers."
      },
      {
        "type": "separation_of_concerns",
        "file": "src/config/constants.ts",
        "line": 15,
        "severity": "L",
        "failure_code": "PRA-MAT/L",
        "title": "Version constant mixes runtime constants with release process concerns",
        "description": "SDK_CORE_VERSION (src/config/constants.ts:15) is manually kept in sync with package.json (README.md:10 notes the current version as 0.1.1). While not incorrect, this couples the config constants module to the release process, and any missed bump leads to inconsistencies.",
        "suggestion": "Document in the README or CONTRIBUTING that SDK_CORE_VERSION must be updated on every release, or introduce a small script that verifies alignment between package.json and constants.ts as part of CI. This keeps responsibilities clear and reduces human error in release engineering."
      }
    ]
  },
  "auto_fail": {
    "AF-001_security_vulnerabilities": "CLEAR",
    "AF-002_error_handling_critical_paths": "CLEAR",
    "AF-003_code_functionality": "CLEAR",
    "AF-004_missing_core_tests": "CLEAR",
    "AF-005_breaking_changes_without_migration": "CLEAR"
  },
  "details": {
    "files_reviewed": [
      "package.json",
      "tsconfig.json",
      "vitest.config.ts",
      "eslint.config.js",
      "src/index.ts",
      "src/config/constants.ts",
      "src/config/loaders.ts",
      "src/errors/errors.ts",
      "src/http/http-client.ts",
      "src/http/auth-strategy.ts",
      "src/utils/helpers.ts",
      "src/utils/logger.ts",
      "test/setup.ts",
      "test/http-client.test.ts",
      "test/loaders.test.ts",
      "test/errors.test.ts",
      "test/helpers.test.ts",
      "test/logger.test.ts",
      "test/auth-strategy.test.ts",
      "README.md",
      "docs/consumer-validate-report-2026-02-11T17-56-42.md"
    ],
    "validation_results": {
      "code_quality": {
        "score": 29,
        "max_score": 30,
        "criteria": [
          {
            "name": "Functions are single-purpose",
            "score": 4,
            "max_score": 5,
            "deduction_reason": "HttpClient aggregates multiple responsibilities (config wiring, auth strategy management, retry/backoff logic, envelope parsing, raw/binary helpers, error mapping) into one large class (src/http/http-client.ts:102–~746). While methods are individually small and cohesive, the class itself is a central hub for many concerns.",
            "evidence": [
              "src/http/http-client.ts:102–140 – class HttpClient fields include baseUrl, authBaseUrl, timeout, authStrategy, logger, retries, defaultHeaders, lastRateLimitInfo, refreshPromise.",
              "src/http/http-client.ts:142–175 – createFetchClient used for auth strategy login/refresh.",
              "src/http/http-client.ts:194–243 – request<T>() implements retry, schema validation, token refresh, and orchestration.",
              "src/http/http-client.ts:343–406 – doFetch handles URL building, auth header injection, timeout, envelope parsing, and error mapping.",
              "src/http/http-client.ts:408–465 – executeFetch is a low-level primitive reused by requestRaw/requestBinary.",
              "src/http/http-client.ts:473–504 and 512–520 – requestRaw and requestBinary provide separate access modes."
            ],
            "failure_code": "PRA-FRA/M"
          },
          {
            "name": "Clear, descriptive naming",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "Names like HttpClientConfig, loadStoredCredentials, validateCredentials, ApiKeyAuth, JwtSessionAuth, parseRateLimitHeaders, RateLimitError, ServiceUnavailableError are all descriptive and self-explanatory.",
              "src/utils/helpers.ts:25–59 – retry with options { maxRetries, baseDelayMs, maxDelayMs, shouldRetry } uses domain-relevant terms.",
              "src/config/loaders.ts:188–243 – loadCredentials and loadConfig clearly indicate what they load."
            ],
            "failure_code": null
          },
          {
            "name": "No code duplication",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "Search across src/ for repeated large blocks showed only intentional reuse (e.g., similar env-var logic) with small, commented variants.",
              "Credential loading priority is implemented once in loadCredentials (src/config/loaders.ts:188–243) and reused via loadConfig."
            ],
            "failure_code": null
          },
          {
            "name": "Error handling in critical paths",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "src/http/http-client.ts:170–175 – createFetchClient wraps fetch in try/catch and passes errors into handleFetchError.",
              "src/http/http-client.ts:363–405 – doFetch wraps fetch with timeout and maps non-OK responses into typed SdkApiError subclasses via createHttpError.",
              "src/http/http-client.ts:375–381 – explicit UnauthorizedError with clear remediation when 401 and no auth configured.",
              "src/config/loaders.ts:146–181 – loadStoredCredentials catches JSON parse errors, logs a console.warn with context, and safely falls back to other sources.",
              "src/errors/errors.ts:198–234 – createErrorFromStatus centralizes HTTP->error mapping for consistency."
            ],
            "failure_code": null
          },
          {
            "name": "No dead/commented code",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "Search for commented-out code patterns and unused exports did not surface dead blocks; comments are explanatory (e.g., SAFETY comments in http-client).",
              "All exported functions/classes from src/index.ts have corresponding usage in test files or are part of documented public API."
            ],
            "failure_code": null
          },
          {
            "name": "Complexity is manageable",
            "score": 5,
            "max_score": 5,
            "deduction_reason": "Although HttpClient is large overall, individual methods keep cyclomatic complexity low and nesting shallow. The only structural concern is the breadth of responsibility already captured under single-purpose criterion; no additional deduction applied here.",
            "evidence": [
              "src/utils/helpers.ts – all helpers are short, with retry() using a simple for-loop with clear exit conditions (lines 43–55).",
              "src/config/loaders.ts – high-level functions (loadCredentials, loadConfig) branch on limited conditions with clear comments and no deep nesting.",
              "src/errors/errors.ts – each error subclass is simple and focused on constructor wiring.",
              "src/http/http-client.ts – methods like shouldRetryTransient, attemptTokenRefresh, buildRequestUrl, parseJsonEnvelope, executeFetch, requestRaw, requestBinary are individually concise and well-documented."
            ],
            "failure_code": null
          }
        ]
      },
      "standards_compliance": {
        "score": 24,
        "max_score": 25,
        "criteria": [
          {
            "name": "Follows project style guide",
            "score": 10,
            "max_score": 10,
            "deduction_reason": null,
            "evidence": [
              "eslint.config.js configures @eslint/js + typescript-eslint for src/**/*.ts and ignores test/**/*.ts and *.js, matching an ESM TS project.",
              "No obvious lint issues in inspected files: consistent use of import type, explicit return types, no unused imports, no 'any' usage in src.",
              "Naming, semicolons, and spacing are consistent across src files."
            ],
            "failure_code": null
          },
          {
            "name": "Consistent formatting",
            "score": 4,
            "max_score": 5,
            "deduction_reason": "Formatting is essentially uniform; only very minor inconsistencies like arrow function argument parenthesis in sanitizeForLog stand out.",
            "evidence": [
              "src/utils/logger.ts:40–42 – uses `value.map(item => sanitizeForLog(item, seen));` while most code uses `(item) =>` form; this is a trivial inconsistency.",
              "Overall, indentation, bracket style, and whitespace are consistent throughout src and tests."
            ],
            "failure_code": "STR-INC/L"
          },
          {
            "name": "No unused imports/dependencies",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "All imports in src files inspected are referenced.",
              "Dependencies in package.json (dotenv, zod, nock, vitest, eslint, typescript, typescript-eslint) are all used either in code or tests.",
              "No undeclared imports were observed in src or tests."
            ],
            "failure_code": null
          },
          {
            "name": "Documentation present",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "README.md is extensive (590 lines) covering HttpClient, Authentication, Errors, Configuration, and Utilities with code examples.",
              "Public APIs are largely documented with TSDoc comments (e.g., HttpClientConfig in src/http/http-client.ts:34–59, Credentials in src/config/loaders.ts:20–29, RateLimitInfo and parseRateLimitHeaders in src/utils/helpers.ts:97–132).",
              "docs/consumer-validate-report-2026-02-11T17-56-42.md references JSDoc coverage work and indicates strong documentation culture.",
              "Although validateCredentials is not called out in README, it is covered indirectly by tests and naming; given the overall doc volume and clarity, no major deduction beyond the small issue logged."
            ],
            "failure_code": null
          }
        ]
      },
      "testing": {
        "score": 25,
        "max_score": 25,
        "criteria": [
          {
            "name": "Unit tests exist for new code",
            "score": 10,
            "max_score": 10,
            "deduction_reason": null,
            "evidence": [
              "test/http-client.test.ts (934 lines) exercises HttpClient construction, request(), retries, 401 token refresh, doFetch envelope parsing, requestRaw(), requestBinary(), error mapping, timeout behavior, query params, and rate limit headers.",
              "test/auth-strategy.test.ts (322 lines) covers ApiKeyAuth, JwtSessionAuth, and createAuthStrategy in detail, including validation and refresh behavior.",
              "test/errors.test.ts (431 lines) covers all error classes, createErrorFromStatus, and type guard functions.",
              "test/loaders.test.ts (532 lines) covers loadEnvFiles, loadStoredCredentials, loadCredentials, loadConfig, isApiKey, validateCredentials, and path helpers.",
              "test/helpers.test.ts (403 lines) tests sleep, retry (including exponential backoff and maxDelayMs), isPlainObject, isUuid, truncate, parseRateLimitHeaders, and toQuery.",
              "test/logger.test.ts (345 lines) covers createLogger behavior in enabled/disabled modes and sanitization helpers."
            ],
            "failure_code": null
          },
          {
            "name": "Tests cover edge cases",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "test/loaders.test.ts:92–181 – loadStoredCredentials tests missing file, malformed JSON, expired session tokens, named profiles, etc.",
              "test/helpers.test.ts:55–71 – retry tests maxRetries exhaustion and shouldRetry returning false, plus concurrent retries.",
              "test/http-client.test.ts – covers 4xx/5xx responses, invalid JSON from API, empty body, 204 No Content, 401 without authStrategy, network errors, and abort timeouts (lines 879–896).",
              "test/logger.test.ts:185–259 – sanitizeForDisplay tests nested objects, arrays, various key casing and patterns, and non-string sensitive values.",
              "test/loaders.test.ts:484–527 – validateCredentials tests all valid combinations plus invalid email-only/password-only/empty credentials paths."
            ],
            "failure_code": null
          },
          {
            "name": "Tests verify behavior, not implementation",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "Tests use Vitest and nock to assert on observable behaviors (HTTP calls, thrown error types/messages, return values) rather than mocking internals of the functions under test.",
              "E.g., test/http-client.test.ts uses real HttpClient with nock interceptors rather than mocking its private methods.",
              "test/logger.test.ts inspects console calls and sanitized argument values, not internal SENSITIVE_KEYS or WeakSet usage."
            ],
            "failure_code": null
          },
          {
            "name": "Tests actually run and pass",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "vitest.config.ts defines test configuration with coverage thresholds (lines 14–17) and includes setupFiles.",
              "docs/consumer-validate-report-2026-02-11T17-56-42.md:268–269 notes 297 tests passing across 6 test files, indicating the test suite runs successfully with strong coverage.",
              "package.json scripts: \"test\": \"vitest run\", \"test:coverage\": \"vitest run --coverage\" (lines 41–43)."
            ],
            "failure_code": null
          }
        ]
      },
      "best_practices": {
        "score": 18,
        "max_score": 20,
        "criteria": [
          {
            "name": "Security basics followed",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "No hardcoded API secrets or live keys in src; only TEST_API_KEY in test/setup.ts:11 which is clearly test data.",
              "Logger sanitization (src/utils/logger.ts:25–55, 62–87) redacts fields matching SENSITIVE_KEYS including apiKey, token, password, authorization, cookie, credentials, access-token, refresh-token.",
              "Http client error handling strips potentially sensitive details via REDACTED_DETAIL_KEYS in src/http/http-client.ts (lines 61–67 and later in error mapping).",
              "No raw string SQL or command execution patterns are present; code is an HTTP/SDK layer, not DB or shell code."
            ],
            "failure_code": null
          },
          {
            "name": "No performance anti-patterns",
            "score": 5,
            "max_score": 5,
            "deduction_reason": null,
            "evidence": [
              "retry() in src/utils/helpers.ts uses exponential backoff with maxDelayMs, avoiding tight retry loops.",
              "HttpClient methods do single fetch calls per request, with retry controlled by isRetryable() status and backoff constants (BACKOFF_BASE_MS, MAX_BACKOFF_MS).",
              "No O(n²) nested loops over unbounded user data; most iterations are over small objects or header sets.",
              "No synchronous blocking I/O in request paths (only node:fs usage in config loaders, which are generally startup-time operations)."
            ],
            "failure_code": null
          },
          {
            "name": "Separation of concerns",
            "score": 4,
            "max_score": 5,
            "deduction_reason": "Overall separation is strong (HTTP vs config vs errors vs utils), but SDK_CORE_VERSION’s manual version syncing mixes runtime constants with release concerns, which is slightly cross-cutting. This is minor and mostly process-related.",
            "evidence": [
              "Package layers are well separated: http, config, errors, utils live in distinct subdirectories and are re-exported from src/index.ts.",
              "Auth strategies live in src/http/auth-strategy.ts, and configuration/credential resolution in src/config/loaders.ts, not inside the HttpClient itself.",
              "SDK_CORE_VERSION in src/config/constants.ts:15 depends on release process and must stay in sync with package.json:3, adding a small cross-cutting maintenance concern."
            ],
            "failure_code": "PRA-MAT/L"
          },
          {
            "name": "Dependencies justified",
            "score": 4,
            "max_score": 5,
            "deduction_reason": "All dependencies observed are reasonable for the domain, but there is no explicit justification or comments for dotenv in core; however dotenv is only used by config loaders and is appropriate for SDK configuration.",
            "evidence": [
              "dotenv (package.json:68) is used only in src/config/loaders.ts to load .env files via loadDotenv (line 11).",
              "zod is used for optional runtime validation via ZodType in http-client and in tests (test/http-client.test.ts:190–199).",
              "nock is a devDependency used appropriately for HTTP mocking in tests.",
              "eslint, typescript, vitest, @vitest/coverage-v8, and typescript-eslint are standard tooling.",
              "No duplicate deps providing the same functionality were identified."
            ],
            "failure_code": "PRA-EFF/L"
          }
        ]
      }
    },
    "decision": {
      "status": "PASS",
      "justification": "Overall score is 96/100, comfortably above the 70 threshold. No critical (/C) or high (/H) severity issues were identified. Security basics are solid (sensitive value redaction, no hardcoded secrets, clear auth error messages). Error handling for network paths and configuration loading is robust and well-tested. The only issues are minor: a broad but still manageable HttpClient class, a version constant drift risk, and very small documentation/formatting polish items. These do not warrant blocking progression to the next phase.",
      "notes": [
        "Recommend aligning SDK_CORE_VERSION with package.json version in the next change to avoid confusion for consumers and tooling that may rely on the constant.",
        "Consider gradual refactoring of HttpClient into smaller collaborating components if the class grows further; current state is acceptable but close to the upper limit of desirable size.",
        "Documentation and test coverage are both strong; keep enforcing vitest coverage thresholds in vitest.config.ts as the codebase evolves."
      ]
    }
  }
}