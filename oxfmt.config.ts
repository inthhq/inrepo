import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    ".agents/**",
    ".inrepo/**",
    "examples/**/vendor/**",
    "inrepo_modules/**",
  ],
});
