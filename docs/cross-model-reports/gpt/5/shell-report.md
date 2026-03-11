{
  "report_title": "🔍 VALIDATOR REPORT - PHASE (packages/shell)",
  "files_reviewed": [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "eslint.config.js",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "docs/shell-features-list-2026-03-01T10-49-14.md",
    "src/index.ts",
    "src/types.ts",
    "src/tokens.ts",
    "src/tokens.test.ts",
    "src/test-setup.ts",
    "src/styles.css",
    "src/ProductSwitcher.tsx",
    "src/ProductSwitcher.test.tsx",
    "src/PlatformTopBar.tsx",
    "src/PlatformTopBar.test.tsx",
    "src/UserMenu.tsx",
    "src/UserMenu.test.tsx",
    "src/CLAUDE.md"
  ],
  "results": {
    "score_total": 97,
    "code_quality": 27,
    "standards_compliance": 25,
    "testing": 25,
    "best_practices": 20
  },
  "reasoning_trace": {
    "notes": [
      "Detected TypeScript/React project via package.json (type: module, tsconfig NodeNext).",
      "Automated tools (eslint, vitest) could not be executed in this environment; criteria depending on tooling were evaluated by static inspection per guidelines."
    ],
    "code_quality": {
      "score": 27,
      "deductions": [
        {
          "criterion": "Functions are single-purpose",
          "points_lost": 3,
          "failure_code": "PRA-FRA/M",
          "evidence": [
            "src/UserMenu.tsx:29-184 — UserMenu component is ~156 lines and handles multiple concerns (auth fallback/sign-in link, avatar validation, dropdown open/close, focus management, keyboard navigation). This exceeds the ≤50 line guidance and mixes several responsibilities."
          ],
          "context": "Long, multi-responsibility React components increase maintenance cost and make targeted testing/refactoring harder. Consider extracting focus/keyboard logic into a useUserMenuInteractions hook and avatar/display-name logic into small helpers/subcomponents."
        }
      ],
      "passes": [
        "Clear, descriptive naming across components and types",
        "No observable duplication or dead/commented code",
        "Error handling/validation in user-facing paths via SAFE_HREF_RE and avatar URL checks",
        "Manageable complexity (low nesting, simple control flow)"
      ]
    },
    "standards_compliance": {
      "score": 25,
      "deductions": [],
      "passes": [
        "Consistent formatting and import style across TS/TSX files",
        "ESLint configuration present and appropriate for TS/React (typescript-eslint + js recommended)",
        "No unused imports apparent by inspection",
        "Documentation present: README comprehensively documents public API; JSDoc blocks on exported utilities"
      ],
      "tooling_notes": [
        "Linter not executed here; evaluated by inspection with no violations observed."
      ]
    },
    "testing": {
      "score": 25,
      "deductions": [],
      "passes": [
        "Unit tests exist for new/changed modules: tokens, ProductSwitcher, PlatformTopBar, UserMenu",
        "Edge cases covered: ENV handling, href sanitization, avatar URL protocol/host checks, display name fallbacks, keyboard navigation, outside click/escape behavior",
        "Behavior-focused tests using Testing Library; assertions on DOM/ARIA, no mocking of functions under test"
      ],
      "tooling_notes": [
        "Test suite not executed here; by static review tests appear valid and comprehensive. Per guidelines, no penalty when tooling is unavailable."
      ]
    },
    "best_practices": {
      "score": 20,
      "deductions": [],
      "passes": [
        "Security basics: href sanitization to block javascript:/data: in nav; avatar URLs restricted to https (and http://localhost in dev); rel=\"noopener noreferrer\" on anchors",
        "No performance antipatterns evident",
        "Separation of concerns: tokens/config separated from UI; components composed cleanly",
        "Dependencies are minimal, standard, and appropriate"
      ]
    }
  },
  "issues_found": {
    "critical": [],
    "warnings": [
      {
        "issue": "Large, multi-responsibility component exceeds 50-line guidance for single-purpose functions",
        "file": "src/UserMenu.tsx",
        "line": 29,
        "failure_code": "PRA-FRA/M",
        "suggestion": "Extract keyboard/focus management into a dedicated hook (e.g., useUserMenuInteractions), and separate avatar/display-name rendering into small subcomponents or helpers to keep the main component focused and shorter."
      }
    ],
    "suggestions": []
  },
  "summary_counts": {
    "total_issues": 1,
    "by_severity": {
      "C": 0,
      "H": 0,
      "M": 1,
      "L": 0,
      "I": 0
    },
    "by_domain": {
      "SEM": 0,
      "STR": 0,
      "PRA": 1,
      "EPI": 0
    },
    "by_type": {
      "single_purpose_functions": 1
    }
  },
  "auto_fail_conditions": {
    "AF-001 Security vulnerabilities detected": "✅ Clear",
    "AF-002 Missing error handling in critical paths": "✅ Clear",
    "AF-003 Code does not function": "✅ Clear",
    "AF-004 Missing tests for core functionality": "✅ Clear",
    "AF-005 Breaking changes without migration path": "✅ Clear"
  },
  "decision": {
    "status": "PASS",
    "reasoning": "Score 97/100 (≥70) with no critical issues. Solid tests across components and utilities, appropriate validation of user-facing inputs (href, avatar URL), and clear API/docs. One maintainability warning regarding a long, multi-responsibility component should be addressed in a follow-up refactor but does not block progression."
  }
}