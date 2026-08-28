// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Small and conventional on purpose: `@typescript-eslint`'s untyped
 * `recommended` preset (no `parserOptions.project`, so it never needs to
 * resolve this monorepo's several independent `tsconfig.json`s) plus the two
 * long-standing `eslint-plugin-react-hooks` rules -- `rules-of-hooks` and
 * `exhaustive-deps` -- picked out by hand rather than that plugin's own
 * `recommended`/`recommended-latest` presets, which as of v7 also pull in a
 * dozen React Compiler-oriented rules (purity, immutability, "components
 * must be static", ...) this codebase was never written against. Widening to
 * those, or to `recommendedTypeChecked`, is a separate decision for a
 * separate round, not something to fold into "add a linter".
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.tsbuildinfo",
      "apps/web/next-env.d.ts",
      // A git submodule with its own history, conventions, and (per Task
      // 21's brief) review -- not this round's to reformat.
      "vendor/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // `verbatimModuleSyntax` (on across the whole repo, see
      // tsconfig.base.json) already forces type-only imports to say so
      // explicitly; nothing here needs to re-enforce that syntactically.

      // The codebase's own existing convention for "this parameter is
      // required by the signature but this call site has no use for it" --
      // see `apps/web/src/app/api/ai/[key]/route.ts`'s `_request` (predates
      // this config) -- rather than a rule that would force renaming call
      // sites or sprinkling disable comments over an established pattern.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  }
);
