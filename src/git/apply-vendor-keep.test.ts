import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { applyVendorKeep } from "./apply-vendor-keep.js";

const seedTree = async function seedTree(root: string): Promise<void> {
  await mkdir(nodePath.join(root, "src", "lib"), { recursive: true });
  await mkdir(nodePath.join(root, "docs", "images"), { recursive: true });
  await mkdir(nodePath.join(root, "tests"), { recursive: true });
  await writeFile(nodePath.join(root, "package.json"), "{}", "utf-8");
  await writeFile(nodePath.join(root, "README.md"), "# r", "utf-8");
  await writeFile(nodePath.join(root, "src", "index.ts"), "x", "utf-8");
  await writeFile(nodePath.join(root, "src", "lib", "util.ts"), "x", "utf-8");
  await writeFile(nodePath.join(root, "docs", "guide.md"), "d", "utf-8");
  await writeFile(
    nodePath.join(root, "docs", "images", "logo.png"),
    "p",
    "utf-8"
  );
  await writeFile(nodePath.join(root, "tests", "a.test.ts"), "t", "utf-8");
};

describe("applyVendorKeep", () => {
  let dest: string;

  beforeEach(async () => {
    dest = await makeTmpDir("inrepo-keep-");
    await seedTree(dest);
  });

  afterEach(async () => {
    await cleanupTmpDir(dest);
  });

  test("no-op when keep list is empty", async () => {
    await applyVendorKeep(dest, []);
    expect(existsSync(nodePath.join(dest, "docs", "guide.md"))).toBe(true);
    expect(existsSync(nodePath.join(dest, "tests", "a.test.ts"))).toBe(true);
  });

  test("keeps only listed prefixes and required ancestors", async () => {
    await applyVendorKeep(dest, ["src", "package.json"]);
    expect(existsSync(nodePath.join(dest, "src", "index.ts"))).toBe(true);
    expect(existsSync(nodePath.join(dest, "src", "lib", "util.ts"))).toBe(true);
    expect(existsSync(nodePath.join(dest, "package.json"))).toBe(true);

    expect(existsSync(nodePath.join(dest, "README.md"))).toBe(false);
    expect(existsSync(nodePath.join(dest, "docs"))).toBe(false);
    expect(existsSync(nodePath.join(dest, "tests"))).toBe(false);
  });

  test("keeps a deep nested prefix and removes siblings", async () => {
    await applyVendorKeep(dest, ["docs/images"]);
    expect(existsSync(nodePath.join(dest, "docs", "images", "logo.png"))).toBe(
      true
    );
    expect(existsSync(nodePath.join(dest, "docs", "guide.md"))).toBe(false);
    expect(existsSync(nodePath.join(dest, "src"))).toBe(false);
  });

  test("throws when keep list matches no paths", async () => {
    await expect(applyVendorKeep(dest, ["nope/never"])).rejects.toThrow(
      /keep allowlist matched no paths/u
    );
  });

  test("normalizes backslash separators and trailing slashes", async () => {
    await applyVendorKeep(dest, ["src\\lib/"]);
    expect(existsSync(nodePath.join(dest, "src", "lib", "util.ts"))).toBe(true);
    expect(existsSync(nodePath.join(dest, "src", "index.ts"))).toBe(false);
  });

  test("throws on missing dest", async () => {
    await expect(
      applyVendorKeep(nodePath.join(dest, "missing"), ["src"])
    ).rejects.toThrow(/Cannot resolve vendor directory for keep/u);
  });
});
