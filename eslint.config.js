// ESLint flat config.
//
// `npm run lint` existed in package.json long before any of this: no eslint
// dependency, no config, so it failed with "'eslint' is not recognized" and CI
// never ran it. A script that advertises a check nobody can run is worse than no
// script.
//
// Type-aware linting is deliberately not enabled. It needs a TypeScript program
// per run, which is slow, and `npm run typecheck` already runs the real compiler
// with the project's own strictness. This catches what tsc does not: unused
// values, floating scope, accidental `any`.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // AGENTS.md: "No `any` without a comment justifying it." A comment cannot
      // be enforced, so this warns rather than errors -- visible, not blocking.
      "@typescript-eslint/no-explicit-any": "warn",
      // Underscore prefix is the conventional "deliberately unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests mock aggressively and assert on shapes the compiler cannot see.
    files: ["**/__tests__/**", "**/__integration__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  }
);
