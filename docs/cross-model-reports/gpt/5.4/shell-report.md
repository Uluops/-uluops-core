{
  "phase": "unknown",
  "decision": "PASS",
  "score": {
    "total": 94,
    "code_quality": 29,
    "standards_compliance": 20,
    "testing": 25,
    "best_practices": 20
  },
  "files_reviewed": [
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "vitest.config.ts",
    "src/index.ts",
    "src/types.ts",
    "src/tokens.ts",
    "src/UserMenu.tsx",
    "src/ProductSwitcher.tsx",
    "src/PlatformTopBar.tsx",
    "src/tokens.test.ts",
    "src/UserMenu.test.tsx",
    "src/ProductSwitcher.test.tsx",
    "src/PlatformTopBar.test.tsx",
    "src/test-setup.ts"
  ],
  "reasoning_trace": {
    "code_quality": {
      "score": 29,
      "items": [
        {
          "criterion": "Functions are single-purpose",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/tokens.ts:41",
            "src/tokens.ts:54",
            "src/ProductSwitcher.tsx:15",
            "src/PlatformTopBar.tsx:25",
            "src/UserMenu.tsx:29"
          ],
          "context": "Functions are cohesive and named for a single responsibility. UserMenu is the largest component but remains within the stated 50-line threshold for function body length and encapsulates one UI concern."
        },
        {
          "criterion": "Clear, descriptive naming",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/UserMenu.tsx:7",
            "src/UserMenu.tsx:101",
            "src/tokens.ts:41",
            "src/tokens.ts:54"
          ],
          "context": "Names such as resolveDisplayName, handleMenuKeyDown, getProductUrl, and getOtherProduct clearly communicate purpose."
        },
        {
          "criterion": "No code duplication",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/tokens.ts:15-30",
            "src/UserMenu.tsx:35-69",
            "src/PlatformTopBar.tsx:34-47"
          ],
          "context": "No copy-pasted production code blocks greater than 5 lines were found. Shared logic is centralized in tokens.ts."
        },
        {
          "criterion": "Error handling in critical paths",
          "points": 4,
          "deduction": 1,
          "evidence": [
            "src/UserMenu.tsx:97-99"
          ],
          "context": "The development-only warning logs rejected avatar URLs but emits raw user-provided data into console output. This is not a blocking error-handling gap, but the message could be safer and less noisy."
        },
        {
          "criterion": "No dead/commented code",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/UserMenu.tsx:35",
            "src/UserMenu.tsx:51",
            "src/UserMenu.tsx:64"
          ],
          "context": "Comments are explanatory rather than commented-out code. No dead code blocks were identified in reviewed source files."
        },
        {
          "criterion": "Complexity is manageable",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/UserMenu.tsx:101-126",
            "src/PlatformTopBar.tsx:25-53",
            "src/ProductSwitcher.tsx:15-43"
          ],
          "context": "Complexity remains reasonable; nesting depth is low and control flow is easy to follow."
        }
      ]
    },
    "standards_compliance": {
      "score": 20,
      "items": [
        {
          "criterion": "Follows project style guide",
          "points": 7,
          "deduction": 3,
          "evidence": [
            "package.json:55"
          ],
          "context": "Formatting in package.json is inconsistent; jsdom is misindented relative to surrounding dependencies, which suggests style drift in edited config."
        },
        {
          "criterion": "Consistent formatting",
          "points": 4,
          "deduction": 1,
          "evidence": [
            "package.json:54-56"
          ],
          "context": "The dependency block has inconsistent indentation, though source TS/TSX files are otherwise consistently formatted."
        },
        {
          "criterion": "No unused imports/dependencies",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/index.ts:1-14",
            "src/UserMenu.tsx:1-4",
            "src/ProductSwitcher.tsx:1-3",
            "src/PlatformTopBar.tsx:1-5"
          ],
          "context": "Reviewed source imports are used. Declared runtime and test dependencies align with the package’s React/Vitest setup."
        },
        {
          "criterion": "Documentation present",
          "points": 4,
          "deduction": 1,
          "evidence": [
            "src/index.ts:1-14",
            "src/types.ts:1-42"
          ],
          "context": "Public components and utility functions are documented well, but exported barrel/type surface in index.ts and types.ts is not individually documented. This is minor because the main public APIs do have JSDoc."
        }
      ]
    },
    "testing": {
      "score": 25,
      "items": [
        {
          "criterion": "Unit tests exist for new code",
          "points": 10,
          "deduction": 0,
          "evidence": [
            "src/tokens.test.ts:1-68",
            "src/UserMenu.test.tsx:1-335",
            "src/ProductSwitcher.test.tsx:1-46",
            "src/PlatformTopBar.test.tsx:1-99"
          ],
          "context": "Each exported module in reviewed source has direct test coverage."
        },
        {
          "criterion": "Tests cover edge cases",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/UserMenu.test.tsx:255-286",
            "src/UserMenu.test.tsx:289-333",
            "src/PlatformTopBar.test.tsx:77-89",
            "src/tokens.test.ts:21-30"
          ],
          "context": "Tests include null user handling, unsafe hrefs, avatar URL protocol filtering, production/development environment behavior, whitespace names, and outside-click dismissal."
        },
        {
          "criterion": "Tests verify behavior, not implementation",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/ProductSwitcher.test.tsx:6-44",
            "src/PlatformTopBar.test.tsx:14-97",
            "src/UserMenu.test.tsx:20-333"
          ],
          "context": "Tests primarily assert rendered behavior and accessibility outcomes. No mocking of the functions under test was found."
        },
        {
          "criterion": "Tests actually run and pass",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "package.json:25",
            "vitest.config.ts:3-10",
            "src/test-setup.ts:1"
          ],
          "context": "Vitest is configured correctly and test files are present. No execution tool was available in the provided environment, so this criterion was evaluated from configuration and structure per fallback guidance, without penalizing tool unavailability."
        }
      ]
    },
    "best_practices": {
      "score": 20,
      "items": [
        {
          "criterion": "Security basics followed",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/tokens.ts:4",
            "src/UserMenu.tsx:72-75",
            "src/UserMenu.tsx:91-99",
            "src/PlatformTopBar.tsx:37-43"
          ],
          "context": "The package applies basic href sanitization, restricts avatar URL protocols, and contains no obvious hardcoded secrets or injection patterns."
        },
        {
          "criterion": "No performance anti-patterns",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/UserMenu.tsx:35-62",
            "src/UserMenu.tsx:82-88",
            "src/PlatformTopBar.tsx:36-46"
          ],
          "context": "No concerning synchronous blocking or expensive nested iteration patterns were found. Event listeners are properly cleaned up."
        },
        {
          "criterion": "Separation of concerns",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "src/tokens.ts:15-55",
            "src/PlatformTopBar.tsx:25-53",
            "src/ProductSwitcher.tsx:15-43"
          ],
          "context": "Configuration and navigation logic are separated cleanly from rendering concerns."
        },
        {
          "criterion": "Dependencies justified",
          "points": 5,
          "deduction": 0,
          "evidence": [
            "package.json:21-27",
            "package.json:46-60"
          ],
          "context": "Dependencies are consistent with a typed React component library tested via Vitest and Testing Library; no redundant library usage was evident."
        }
      ]
    }
  },
  "issues": [
    {
      "severity": "medium",
      "type": "standards",
      "failure_code": "STR-INC/M",
      "issue": "Inconsistent formatting in package manifest",
      "location": "package.json:55",
      "explanation": "The jsdom dependency line is misindented compared with the surrounding dependency entries. This is a style-guide/formatting inconsistency in a top-level config file."
    },
    {
      "severity": "low",
      "type": "standards",
      "failure_code": "STR-INC/L",
      "issue": "Dependency block formatting drift",
      "location": "package.json:54-56",
      "explanation": "Mixed indentation appears in the devDependencies section, reducing consistency with the rest of the file."
    },
    {
      "severity": "low",
      "type": "documentation",
      "failure_code": "STR-OMI/M",
      "issue": "Export surface is only partially documented",
      "location": "src/index.ts:1-14",
      "explanation": "Main public components/utilities have JSDoc, but the barrel export and exported type surface are not documented directly. This is minor because the underlying exported APIs are documented."
    },
    {
      "severity": "low",
      "type": "code_quality",
      "failure_code": "SEM-COM/H",
      "issue": "Development warning logs raw rejected avatar URL",
      "location": "src/UserMenu.tsx:97-99",
      "explanation": "Rejected user-provided avatarUrl values are interpolated directly into console.warn output. This is not a production blocker here, but it is better practice to avoid echoing raw untrusted input in diagnostics."
    }
  ],
  "auto_fail_conditions": {
    "AF-001": {
      "name": "Security vulnerabilities detected",
      "triggered": false,
      "evidence": []
    },
    "AF-002": {
      "name": "Missing error handling in critical paths",
      "triggered": false,
      "evidence": []
    },
    "AF-003": {
      "name": "Code does not function",
      "triggered": false,
      "evidence": []
    },
    "AF-004": {
      "name": "Missing tests for core functionality",
      "triggered": false,
      "evidence": []
    },
    "AF-005": {
      "name": "Breaking changes without migration path",
      "triggered": false,
      "evidence": []
    }
  },
  "summary": {
    "total_issues": 4,
    "by_severity": {
      "critical": 0,
      "high": 0,
      "medium": 1,
      "low": 3
    },
    "by_domain": {
      "SEM": 1,
      "STR": 3,
      "PRA": 0,
      "EPI": 0
    },
    "by_type": {
      "code_quality": 1,
      "standards": 2,
      "documentation": 1,
      "testing": 0,
      "best_practices": 0
    }
  },
  "reasoning": "PASS. The package is structurally sound, well-tested, and follows good component-library practices. Source code is cohesive, documented, and includes strong behavior-focused test coverage for all reviewed exported modules. No critical or high-severity blocking issues were identified, and no auto-fail condition was triggered. The only notable problems are minor standards/documentation inconsistencies in package.json formatting and a non-blocking diagnostic logging concern in UserMenu."
}