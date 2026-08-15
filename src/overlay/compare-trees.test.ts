import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { compareTrees } from "./compare-trees.js";

describe("compareTrees", () => {
  let cwd: string;
  let left: string;
  let right: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-compare-");
    left = nodePath.join(cwd, "left");
    right = nodePath.join(cwd, "right");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("detects added, removed, and modified files while ignoring vendor metadata", async () => {
    await writeFile(nodePath.join(left, "same.txt"), "same\n", "utf-8");
    await writeFile(nodePath.join(right, "same.txt"), "same\n", "utf-8");

    await writeFile(nodePath.join(left, "remove.txt"), "gone\n", "utf-8");
    await writeFile(nodePath.join(left, "modify.txt"), "left\n", "utf-8");
    await writeFile(nodePath.join(right, "modify.txt"), "right\n", "utf-8");
    await writeFile(nodePath.join(right, "add.txt"), "new\n", "utf-8");

    await writeFile(
      nodePath.join(left, ".inrepo-vendor.json"),
      '{"commit":"a"}\n',
      "utf-8"
    );
    await writeFile(
      nodePath.join(right, ".inrepo-vendor.json"),
      '{"commit":"b"}\n',
      "utf-8"
    );
    await mkdir(nodePath.join(right, ".git"), { recursive: true });

    const result = await compareTrees(left, right);
    expect(result.added).toEqual(["add.txt"]);
    expect(result.modified).toEqual(["modify.txt"]);
    expect(result.removed).toEqual(["remove.txt"]);
    expect(result.typeChanges).toEqual([]);
    expect(result.unchanged).toEqual(["same.txt"]);
  });

  test("detects binary, executable-bit, and symlink target changes", async () => {
    await writeFile(nodePath.join(left, "bin.dat"), new Uint8Array([0, 1, 2]));
    await writeFile(nodePath.join(right, "bin.dat"), new Uint8Array([0, 1, 3]));

    await writeFile(
      nodePath.join(left, "script.sh"),
      "#!/bin/sh\necho left\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(right, "script.sh"),
      "#!/bin/sh\necho left\n",
      "utf-8"
    );
    await chmod(nodePath.join(left, "script.sh"), 0o644);
    await chmod(nodePath.join(right, "script.sh"), 0o755);

    await writeFile(nodePath.join(left, "target-a.txt"), "a\n", "utf-8");
    await writeFile(nodePath.join(left, "target-b.txt"), "b\n", "utf-8");
    await writeFile(nodePath.join(right, "target-a.txt"), "a\n", "utf-8");
    await writeFile(nodePath.join(right, "target-b.txt"), "b\n", "utf-8");
    await symlink("./target-a.txt", nodePath.join(left, "link.txt"));
    await symlink("./target-b.txt", nodePath.join(right, "link.txt"));

    const result = await compareTrees(left, right);
    expect(result.modified.toSorted()).toEqual([
      "bin.dat",
      "link.txt",
      "script.sh",
    ]);
  });

  test("reports file-to-directory type changes", async () => {
    await writeFile(nodePath.join(left, "swap"), "file\n", "utf-8");
    await mkdir(nodePath.join(right, "swap"), { recursive: true });
    await writeFile(
      nodePath.join(right, "swap", "nested.txt"),
      "nested\n",
      "utf-8"
    );

    const result = await compareTrees(left, right);
    expect(result.typeChanges).toEqual(["swap"]);
    expect(result.added).toEqual(["swap/nested.txt"]);
  });
});
