import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, symlink } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { resolveTargetUrl, targetIdentity } from "./resolve-target-url.js";

describe("resolveTargetUrl", () => {
  test("passes URLs and absolute paths to git as written", () => {
    expect(resolveTargetUrl("/cfg", "https://h/o/r.git")).toBe(
      "https://h/o/r.git"
    );
    expect(resolveTargetUrl("/cfg", "git@h:o/r.git")).toBe("git@h:o/r.git");
    expect(resolveTargetUrl("/cfg", "/base/link/../r.git")).toBe(
      "/base/link/../r.git"
    );
  });

  test("prefixes relative paths with the config directory without normalizing", () => {
    expect(resolveTargetUrl("/cfg", "link/../r.git")).toBe(
      `/cfg${nodePath.sep}link/../r.git`
    );
  });
});

describe("targetIdentity", () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await makeTmpDir("inrepo-target-identity-"));
  });

  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  test("follows symlinks before .. the way git does", async () => {
    await mkdir(nodePath.join(root, "other", "nested"), { recursive: true });
    await mkdir(nodePath.join(root, "other", "public.git"));
    await mkdir(nodePath.join(root, "base", "public.git"), { recursive: true });
    await symlink(
      nodePath.join(root, "other", "nested"),
      nodePath.join(root, "base", "link")
    );
    const viaLink = targetIdentity(root, "base/link/../public.git");
    expect(viaLink).toBe(nodePath.join(root, "other", "public.git"));
    expect(viaLink).not.toBe(targetIdentity(root, "base/public.git"));
    expect(
      targetIdentity(
        root,
        `file://${nodePath.join(root, "other", "public.git")}`
      )
    ).toBe(viaLink);
  });
});
