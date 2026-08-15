import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { listRelativePathsRecursive, pathDepth } from "./vendor-tree-paths.js";

describe("vendor-tree-paths", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-tree-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("listRelativePathsRecursive lists files and directories with POSIX separators", async () => {
    await mkdir(nodePath.join(cwd, "a", "b"), { recursive: true });
    await writeFile(nodePath.join(cwd, "a", "b", "c.txt"), "x", "utf-8");
    await writeFile(nodePath.join(cwd, "top.txt"), "y", "utf-8");
    const list = await listRelativePathsRecursive(cwd);
    expect(list.toSorted()).toEqual(["a", "a/b", "a/b/c.txt", "top.txt"]);
  });

  test("listRelativePathsRecursive returns [] on an empty directory", async () => {
    expect(await listRelativePathsRecursive(cwd)).toEqual([]);
  });

  test("pathDepth counts segments (root-relative)", () => {
    expect(pathDepth("a")).toBe(1);
    expect(pathDepth("a/b")).toBe(2);
    expect(pathDepth("a/b/c")).toBe(3);
  });
});
