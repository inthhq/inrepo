import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { applyVendorExcludes } from "./apply-vendor-excludes.js";

const seedTree = async function seedTree(root: string): Promise<void> {
  await mkdir(nodePath.join(root, ".git"), { recursive: true });
  await mkdir(nodePath.join(root, "docs"), { recursive: true });
  await mkdir(nodePath.join(root, "src"), { recursive: true });
  await mkdir(nodePath.join(root, "tests"), { recursive: true });
  await writeFile(nodePath.join(root, ".git", "HEAD"), "ref", "utf-8");
  await writeFile(nodePath.join(root, ".gitignore"), "node_modules", "utf-8");
  await writeFile(nodePath.join(root, "docs", "guide.md"), "d", "utf-8");
  await writeFile(nodePath.join(root, "src", "index.ts"), "x", "utf-8");
  await writeFile(nodePath.join(root, "tests", "a.test.ts"), "t", "utf-8");
};

describe("applyVendorExcludes", () => {
  let dest: string;

  beforeEach(async () => {
    dest = await makeTmpDir("inrepo-excl-");
    await seedTree(dest);
  });

  afterEach(async () => {
    await cleanupTmpDir(dest);
  });

  test("no-op when list is empty", async () => {
    await applyVendorExcludes(dest, []);
    expect(existsSync(nodePath.join(dest, ".git", "HEAD"))).toBe(true);
    expect(existsSync(nodePath.join(dest, "docs", "guide.md"))).toBe(true);
  });

  test("removes literal relative paths", async () => {
    await applyVendorExcludes(dest, [".git", "docs"]);
    expect(existsSync(nodePath.join(dest, ".git"))).toBe(false);
    expect(existsSync(nodePath.join(dest, "docs"))).toBe(false);
    expect(existsSync(nodePath.join(dest, "src", "index.ts"))).toBe(true);
  });

  test("skips literal entries that do not exist (silent)", async () => {
    await applyVendorExcludes(dest, ["nope.txt"]);
    expect(existsSync(nodePath.join(dest, "src", "index.ts"))).toBe(true);
  });

  test("removes paths matched by /regex/ entries", async () => {
    await applyVendorExcludes(dest, ["/\\.test\\.ts$/"]);
    expect(existsSync(nodePath.join(dest, "tests", "a.test.ts"))).toBe(false);
    expect(existsSync(nodePath.join(dest, "tests"))).toBe(true);
  });

  test("regex entry can target a directory", async () => {
    await applyVendorExcludes(dest, ["/^docs$/"]);
    expect(existsSync(nodePath.join(dest, "docs"))).toBe(false);
  });

  test("rejects invalid slash-style regex (only leading slash, no closing)", async () => {
    await expect(applyVendorExcludes(dest, ["/oops"])).rejects.toThrow(
      /Invalid exclude regex/u
    );
  });

  test("rejects POSIX-style absolute paths via the leading-slash regex check", async () => {
    // "/abs/path" parses as `/abs/` with flags="path", which is rejected as an
    // invalid slash-style regex (flags must be a-z only and the body must be a
    // valid RegExp). The error message comes from the leading-slash branch, not
    // from the absolute-path branch, so we assert the precise text here.
    await expect(applyVendorExcludes(dest, ["/abs/path"])).rejects.toThrow(
      /Invalid exclude regex \(expected \/pattern\/ or \/pattern\/flags\)/u
    );
  });

  test("rejects Windows-style absolute paths with the relative-path error", async () => {
    // "C:\\foo\\bar" does not start with "/", so the leading-slash branch is
    // skipped and the cross-platform absolute-path guard fires instead.
    await expect(applyVendorExcludes(dest, ["C:\\foo\\bar"])).rejects.toThrow(
      /Exclude path must be relative to the module root/u
    );
  });

  test("rejects unsafe regex (ReDoS)", async () => {
    await expect(applyVendorExcludes(dest, ["/(a+)+$/"])).rejects.toThrow(
      /potentially unsafe \(ReDoS risk\)/u
    );
  });

  test("throws on missing dest", async () => {
    await expect(
      applyVendorExcludes(nodePath.join(dest, "missing"), [".git"])
    ).rejects.toThrow(/Cannot resolve vendor directory for excludes/u);
  });
});
