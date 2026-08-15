import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

const ignorePatterns = [
  ...core.ignorePatterns,
  ".agents/**",
  ".inrepo/**",
  "examples/**/vendor/**",
  "inrepo_modules/**",
];

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns,
  overrides: [
    {
      files: ["src/json/unknown.ts"],
      rules: {
        "anti-slop/no-unknown-parameters": "off",
        "anti-slop/no-unknown-returns": "off",
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
    // `(await readX()).field` is the readable form in this CLI and its tests.
    "unicorn/no-await-expression-member": "off",
  },
});
