import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { copyTree } from "../overlay/tree-utils.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { applySeries } from "./apply-series.js";
import { comparePatchedTrees } from "./compare-patched-trees.js";
import { formatSeriesPatch } from "./format-series-patch.js";

const writePatch = async function writePatch(
  seriesDir: string,
  opts: {
    baseRoot: string;
    patchedRoot: string;
    subject: string;
    startNumber: number;
  }
): Promise<string> {
  const patch = await formatSeriesPatch(opts);
  await mkdir(seriesDir, { recursive: true });
  await writeFile(nodePath.join(seriesDir, patch.fileName), patch.content);
  return patch.fileName;
};

describe("applySeries", () => {
  let cwd: string;
  let pristine: string;
  let seriesDir: string;
  let target: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-series-apply-");
    pristine = nodePath.join(cwd, "pristine");
    seriesDir = nodePath.join(cwd, "series");
    target = nodePath.join(cwd, "target");

    await mkdir(nodePath.join(pristine, "src"), { recursive: true });
    await mkdir(nodePath.join(pristine, "docs"), { recursive: true });
    await mkdir(nodePath.join(pristine, "bin"), { recursive: true });
    await mkdir(nodePath.join(pristine, "assets"), { recursive: true });
    await writeFile(
      nodePath.join(pristine, "README.md"),
      "# upstream\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(pristine, "src", "index.ts"),
      "export const value = 1;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(pristine, "docs", "guide.md"),
      "# guide\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(pristine, "docs", "faq.md"),
      "# faq\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(pristine, "bin", "tool.sh"),
      "#!/bin/sh\necho tool\n",
      "utf-8"
    );
    await chmod(nodePath.join(pristine, "bin", "tool.sh"), 0o755);
    await writeFile(
      nodePath.join(pristine, "bin", "plain.sh"),
      "#!/bin/sh\necho plain\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(pristine, "assets", "logo.bin"),
      new Uint8Array([0, 1, 2, 3, 255, 0])
    );
    await symlink("./README.md", nodePath.join(pristine, "readme-link"));
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("applies an ordered series covering text, binary, deletions, symlinks, and modes", async () => {
    const first = nodePath.join(cwd, "first");
    await copyTree(pristine, first);
    await writeFile(
      nodePath.join(first, "src", "index.ts"),
      "export const value = 2;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(first, "src", "local.ts"),
      "export const local = true;\n",
      "utf-8"
    );
    await rm(nodePath.join(first, "docs", "guide.md"));

    const second = nodePath.join(cwd, "second");
    await copyTree(first, second);
    await writeFile(
      nodePath.join(second, "src", "index.ts"),
      "export const value = 3;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(second, "assets", "logo.bin"),
      new Uint8Array([9, 8, 7, 6, 0, 254])
    );
    await chmod(nodePath.join(second, "bin", "plain.sh"), 0o755);
    await chmod(nodePath.join(second, "bin", "tool.sh"), 0o644);
    await rm(nodePath.join(second, "readme-link"));
    await symlink("./src/index.ts", nodePath.join(second, "readme-link"));

    await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: first,
      startNumber: 1,
      subject: "Bump value and drop the guide",
    });
    await writePatch(seriesDir, {
      baseRoot: first,
      patchedRoot: second,
      startNumber: 2,
      subject: "Swap the binary asset and flip modes",
    });

    const { applied } = await applySeries({
      pristineRoot: pristine,
      seriesDir,
      targetRoot: target,
    });
    expect(applied.map((patch) => patch.fileName)).toEqual([
      "0001-Bump-value-and-drop-the-guide.patch",
      "0002-Swap-the-binary-asset-and-flip-modes.patch",
    ]);

    expect((await comparePatchedTrees(second, target)).differences).toEqual([]);
    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 3;\n");
    expect(
      new Uint8Array(
        await readFile(nodePath.join(target, "assets", "logo.bin"))
      )
    ).toEqual(new Uint8Array([9, 8, 7, 6, 0, 254]));
    expect(existsSync(nodePath.join(target, "docs", "guide.md"))).toBe(false);
    expect(existsSync(nodePath.join(target, "docs", "faq.md"))).toBe(true);
    expect(await readlink(nodePath.join(target, "readme-link"))).toBe(
      "./src/index.ts"
    );
    expect(
      ((await lstat(nodePath.join(target, "bin", "plain.sh"))).mode & 0o111) !==
        0
    ).toBe(true);
    expect(
      ((await lstat(nodePath.join(target, "bin", "tool.sh"))).mode & 0o111) !==
        0
    ).toBe(false);
    expect(existsSync(nodePath.join(target, ".git"))).toBe(false);
  });

  test("applies patches in filename order, not creation order", async () => {
    const first = nodePath.join(cwd, "first");
    await copyTree(pristine, first);
    await writeFile(
      nodePath.join(first, "src", "index.ts"),
      "export const value = 2;\n",
      "utf-8"
    );

    const second = nodePath.join(cwd, "second");
    await copyTree(first, second);
    await writeFile(
      nodePath.join(second, "src", "index.ts"),
      "export const value = 3;\n",
      "utf-8"
    );

    const one = await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: first,
      startNumber: 1,
      subject: "Set value to two",
    });
    const two = await writePatch(seriesDir, {
      baseRoot: first,
      patchedRoot: second,
      startNumber: 2,
      subject: "Set value to three",
    });

    // Applied in order this series is fine; swapping the numeric prefixes makes
    // the dependent patch run first, which cannot apply to the upstream tree.
    expect(
      await (
        await applySeries({
          pristineRoot: pristine,
          seriesDir,
          targetRoot: target,
        })
      ).applied.map((patch) => patch.fileName)
    ).toEqual([one, two]);
    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 3;\n");

    await rename(
      nodePath.join(seriesDir, one),
      nodePath.join(seriesDir, "staged.tmp")
    );
    await rename(
      nodePath.join(seriesDir, two),
      nodePath.join(seriesDir, "0001-set-value-to-three.patch")
    );
    await rename(
      nodePath.join(seriesDir, "staged.tmp"),
      nodePath.join(seriesDir, "0002-set-value-to-two.patch")
    );

    await expect(
      applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target })
    ).rejects.toThrow(/Failed to apply 0001-set-value-to-three\.patch/u);
  });

  test("reports which patch failed and leaves no in-flight git am state", async () => {
    const first = nodePath.join(cwd, "first");
    await copyTree(pristine, first);
    await writeFile(
      nodePath.join(first, "src", "index.ts"),
      "export const value = 2;\n",
      "utf-8"
    );
    await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: first,
      startNumber: 1,
      subject: "Set value to two",
    });

    // The patch was generated against a file that no longer exists upstream.
    const movedUpstream = nodePath.join(cwd, "moved-upstream");
    await copyTree(pristine, movedUpstream);
    await rm(nodePath.join(movedUpstream, "src", "index.ts"));

    await expect(
      applySeries({
        pristineRoot: movedUpstream,
        seriesDir,
        targetRoot: target,
      })
    ).rejects.toThrow(/Failed to apply 0001-Set-value-to-two\.patch/u);
    expect(existsSync(nodePath.join(target, ".git", "rebase-apply"))).toBe(
      false
    );
  });

  test("rejects a patch that introduces a symlink escaping the module root", async () => {
    const escaping = nodePath.join(cwd, "escaping");
    await copyTree(pristine, escaping);
    await symlink(
      "../../etc/passwd",
      nodePath.join(escaping, "src", "escape-link")
    );
    await writePatch(seriesDir, {
      baseRoot: pristine,
      patchedRoot: escaping,
      startNumber: 1,
      subject: "Add an escaping symlink",
    });

    await expect(
      applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target })
    ).rejects.toThrow(
      /Refusing to apply symlink escaping module root at "src\/escape-link"/u
    );
  });

  test("rejects a series directory with no patches", async () => {
    await mkdir(seriesDir, { recursive: true });
    await expect(
      applySeries({ pristineRoot: pristine, seriesDir, targetRoot: target })
    ).rejects.toThrow(/No patches found/u);
  });
});
