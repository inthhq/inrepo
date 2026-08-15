import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { applyOverlay } from "./apply-overlay.js";
import { buildOverlay } from "./build-overlay.js";
import { compareTrees } from "./compare-trees.js";
import { readDeletionsFile } from "./deletions-file.js";
import { copyTree } from "./tree-utils.js";

describe("buildOverlay", () => {
  let cwd: string;
  let pristine: string;
  let moduleRoot: string;
  let overlay: string;
  let applied: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-overlay-build-");
    pristine = nodePath.join(cwd, "pristine");
    moduleRoot = nodePath.join(cwd, "module");
    overlay = nodePath.join(cwd, "inrepo_patches", "upstream");
    applied = nodePath.join(cwd, "applied");

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
      nodePath.join(pristine, "assets", "logo.bin"),
      new Uint8Array([0, 1, 2, 3])
    );
    await symlink("./README.md", nodePath.join(pristine, "readme-link"));

    await copyTree(pristine, moduleRoot);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("round-trips modified files, binaries, deletions, exec bits, and symlinks", async () => {
    await writeFile(
      nodePath.join(moduleRoot, "src", "index.ts"),
      "export const value = 2;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(moduleRoot, "src", "local.ts"),
      "export const local = true;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(moduleRoot, "assets", "logo.bin"),
      new Uint8Array([9, 8, 7, 6])
    );
    await writeFile(
      nodePath.join(moduleRoot, "bin", "tool.sh"),
      "#!/bin/sh\necho patched\n",
      "utf-8"
    );
    await chmod(nodePath.join(moduleRoot, "bin", "tool.sh"), 0o644);
    await rm(nodePath.join(moduleRoot, "docs", "guide.md"));
    await rm(nodePath.join(moduleRoot, "readme-link"));
    await symlink("./src/index.ts", nodePath.join(moduleRoot, "readme-link"));

    await buildOverlay({
      moduleRoot,
      overlayRoot: overlay,
      pristineRoot: pristine,
    });

    expect(
      await readDeletionsFile(nodePath.join(overlay, ".inrepo-deletions"))
    ).toEqual(["docs/guide.md"]);

    const deletions = await readDeletionsFile(
      nodePath.join(overlay, ".inrepo-deletions")
    );
    await applyOverlay({
      deletions,
      overlayRoot: overlay,
      pristineRoot: pristine,
      targetRoot: applied,
    });

    const drift = await compareTrees(applied, moduleRoot);
    expect(drift.added).toEqual([]);
    expect(drift.modified).toEqual([]);
    expect(drift.removed).toEqual([]);
    expect(drift.typeChanges).toEqual([]);
    expect(await readlink(nodePath.join(applied, "readme-link"))).toBe(
      "./src/index.ts"
    );
  });

  test("collapses full-directory deletions into a single entry", async () => {
    await rm(nodePath.join(moduleRoot, "docs"), {
      force: true,
      recursive: true,
    });

    await buildOverlay({
      moduleRoot,
      overlayRoot: overlay,
      pristineRoot: pristine,
    });

    expect(
      await readDeletionsFile(nodePath.join(overlay, ".inrepo-deletions"))
    ).toEqual(["docs/"]);
  });
});
