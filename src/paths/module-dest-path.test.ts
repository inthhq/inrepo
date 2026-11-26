import nodePath from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { moduleDestPath } from "./module-dest-path.js";

describe("moduleDestPath", () => {
  test("returns inrepo_modules/<name> for plain names", () => {
    expect(moduleDestPath("/repo", "lodash")).toBe(
      nodePath.join("/repo", "inrepo_modules", "lodash")
    );
  });

  test("handles scoped names", () => {
    expect(moduleDestPath("/repo", "@clack/prompts")).toBe(
      nodePath.join("/repo", "inrepo_modules", "@clack", "prompts")
    );
  });

  test("throws on invalid scoped names", () => {
    expect(() => moduleDestPath("/repo", "@nopkg")).toThrow(/missing \//u);
    expect(() => moduleDestPath("/repo", "@scope/")).toThrow(
      /Invalid scoped name/u
    );
  });
});
