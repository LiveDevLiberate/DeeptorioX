// Flat ESLint config. Type-aware linting applies to src/**/*.ts; browser scripts
// and Node scripts/tests get the non-type-aware JS rules. The existing codebase
// still has `any` at dynamic boundaries, so unsafe-* rules stay off while the
// typed-boundary work lands; no-floating-promises/no-misused-promises are kept
// as errors because they catch real async bugs.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  performance: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  structuredClone: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
};

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  localStorage: "readonly",
  location: "readonly",
  history: "readonly",
  navigator: "readonly",
  fetch: "readonly",
  console: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  Blob: "readonly",
  atob: "readonly",
  btoa: "readonly",
  EventSource: "readonly",
  CustomEvent: "readonly",
  AbortController: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".autorio/**",
      "factorio-mod/**",
      "native/**",
      "public/*.html",
      "public/blueprint-viewer/**",
      "public/toolkit-viewer/**",
      "benchmarks/**",
      "runs/**",
    ],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: nodeGlobals,
    },
    rules: {
      // Dynamic RCON/Lua/agent payloads are typed incrementally; keep these off
      // until the boundary types land so lint catches real bugs today.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksConditionals: true, checksVoidReturn: false },
      ],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      // ANSI/terminal control characters and Lua/JSON escape sequences are
      // intentional in this codebase; these two stylistic rules misread them.
      "no-control-regex": "off",
      "no-useless-assignment": "off",
    },
  },
  {
    // The pure Lua builders embed Lua source in JS strings; escapes that look
    // useless to JS are meaningful to the Lua parser reading the emitted text.
    files: ["src/command-builders.ts"],
    rules: { "no-useless-escape": "off" },
  },
  {
    files: ["tests/**/*.mjs", "scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "module", globals: nodeGlobals },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": "off",
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["public/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "module", globals: browserGlobals },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": "off",
      "no-control-regex": "off",
    },
  },
);
