import ultraciteFmt from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { defineConfig } from "vite-plus";

const sharedIgnorePatterns = [
  ".agents/**",
  ".claude/skills/**",
  ".inrepo/**",
  "examples/**/vendor/**",
  "inrepo_modules/**",
];

export default defineConfig({
  fmt: {
    ...ultraciteFmt,
    ignorePatterns: [
      ...(ultraciteFmt.ignorePatterns ?? []),
      ...sharedIgnorePatterns,
    ],
  },
  lint: {
    extends: [core, antiSlop],
    ignorePatterns: [
      ...(core.ignorePatterns ?? []),
      ...sharedIgnorePatterns,
      // Standalone example sub-projects carry their own package.json/deps outside root tsconfig.json.
      "examples/**",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["src/json/unknown.ts"],
        rules: {
          "anti-slop/no-unknown-parameters": "off",
          "anti-slop/no-unknown-returns": "off",
        },
      },
      {
        files: ["src/config/load-config.ts"],
        rules: {
          // Generic parameter satisfies anti-slop/no-unknown-parameters on catch-value helper.
          "typescript/no-unnecessary-type-parameters": "off",
        },
      },
      {
        files: ["**/*.test.ts"],
        rules: {
          // Async test stubs required by typescript/promise-function-async return fixture values directly.
          "eslint/require-await": "off",
        },
      },
    ],
    rules: {
      // Command, lexer, and registry parsers are inherently branched.
      complexity: ["error", { max: 60 }],
      // `== null` / `!= null` are the project's nullish checks.
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Sequential git, filesystem, and registry I/O is load-bearing. Parallelizing
      // those loops with Promise.all would change checkout and patch order.
      "eslint/no-await-in-loop": "off",
      // Patch/tar/semver decoders use masks and shifts on purpose.
      "eslint/no-bitwise": "off",
      "eslint/no-eq-null": "off",
      // Type assertions are governed by anti-slop's SAFETY comment and narrowing rules.
      "typescript/no-unsafe-type-assertion": "off",
      // `trimmed || undefined` intentionally coerces empty strings to undefined.
      "typescript/prefer-nullish-coalescing": "off",
      // Truthy string/nullable conditionals are idiomatic in this codebase.
      "typescript/strict-boolean-expressions": "off",
      // `promisify(execFile)` passes a ChildProcess-returning function to Node's promisify.
      "typescript/strict-void-return": "off",
      // `(await readX()).field` is the readable form in this CLI and its tests.
      "unicorn/no-await-expression-member": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
  pack: {
    clean: true,
    dts: false,
    entry: {
      cli: "src/cli.ts",
    },
    fixedExtension: true,
    format: "esm",
    outputOptions: {
      codeSplitting: false,
    },
    platform: "node",
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
