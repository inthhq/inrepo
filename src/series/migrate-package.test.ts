import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { applyLegacyOverlayTree } from "../overlay/assemble-module.js";
import { overlayDirPath, seriesDirPath } from "../overlay/overlay-paths.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { applySeries } from "./apply-series.js";
import { comparePatchedTrees } from "./compare-patched-trees.js";
import { migratePackageToSeries } from "./migrate-package.js";

const NAME = "upstream";

describe("migratePackageToSeries", () => {
  let cwd: string;
  let pristine: string;
  let overlayRoot: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-series-migrate-");
    pristine = nodePath.join(cwd, ".inrepo", "cache", NAME);
    overlayRoot = overlayDirPath(cwd, NAME);

    await mkdir(nodePath.join(pristine, "src"), { recursive: true });
    await mkdir(nodePath.join(pristine, "docs"), { recursive: true });
    await mkdir(nodePath.join(pristine, "bin"), { recursive: true });
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
    await writeFile(
      nodePath.join(pristine, "logo.bin"),
      new Uint8Array([1, 2, 3, 4])
    );
    await symlink("./README.md", nodePath.join(pristine, "readme-link"));
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const writeLegacyOverlay =
    async function writeLegacyOverlay(): Promise<void> {
      await mkdir(nodePath.join(overlayRoot, "src"), { recursive: true });
      await mkdir(nodePath.join(overlayRoot, "bin"), { recursive: true });
      await writeFile(
        nodePath.join(overlayRoot, "src", "index.ts"),
        "export const value = 42;\n",
        "utf-8"
      );
      await writeFile(
        nodePath.join(overlayRoot, "src", "local.ts"),
        "export const local = true;\n",
        "utf-8"
      );
      await writeFile(
        nodePath.join(overlayRoot, "logo.bin"),
        new Uint8Array([9, 9, 9, 9, 0, 1])
      );
      await writeFile(
        nodePath.join(overlayRoot, "bin", "tool.sh"),
        "#!/bin/sh\necho patched\n",
        "utf-8"
      );
      await chmod(nodePath.join(overlayRoot, "bin", "tool.sh"), 0o755);
      await symlink(
        "./src/index.ts",
        nodePath.join(overlayRoot, "readme-link")
      );
      await writeFile(
        nodePath.join(overlayRoot, ".inrepo-deletions"),
        "docs/guide.md\n",
        "utf-8"
      );
    };

  test("replaces the legacy overlay with a series that reproduces the same tree", async () => {
    await writeLegacyOverlay();

    const legacyResult = nodePath.join(cwd, "legacy-result");
    await applyLegacyOverlayTree({
      cwd,
      name: NAME,
      pristineRoot: pristine,
      targetRoot: legacyResult,
    });

    const result = await migratePackageToSeries({
      cwd,
      name: NAME,
      pristineRoot: pristine,
    });

    expect(result.patchFileName).toBe(
      "0001-Import-legacy-inrepo-overlay-for-upstream.patch"
    );
    expect(await readdir(seriesDirPath(cwd, NAME))).toEqual([
      result.patchFileName,
    ]);
    expect(result.removedLegacyEntries).toEqual([
      ".inrepo-deletions",
      "bin",
      "logo.bin",
      "readme-link",
      "src",
    ]);
    expect(await readdir(overlayRoot)).toEqual(["series"]);

    const patchText = await readFile(result.patchPath, "utf-8");
    expect(patchText).toMatch(/^From /u);
    expect(patchText).toMatch(
      /Subject: \[PATCH\] Import legacy inrepo overlay for upstream/u
    );
    expect(patchText).toMatch(/GIT binary patch/u);
    expect(patchText).toMatch(
      /deleted file mode 100644 docs\/guide\.md|delete mode 100644 docs\/guide\.md/u
    );

    const seriesResult = nodePath.join(cwd, "series-result");
    await applySeries({
      pristineRoot: pristine,
      seriesDir: seriesDirPath(cwd, NAME),
      targetRoot: seriesResult,
    });
    expect(
      (await comparePatchedTrees(legacyResult, seriesResult)).differences
    ).toEqual([]);
    expect(
      await readFile(nodePath.join(seriesResult, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 42;\n");
  });

  test("preserves bytes even when upstream .gitattributes asks for eol normalization", async () => {
    await writeFile(
      nodePath.join(pristine, ".gitattributes"),
      "* text=auto eol=lf\n",
      "utf-8"
    );
    await mkdir(overlayRoot, { recursive: true });
    await writeFile(
      nodePath.join(overlayRoot, "crlf.txt"),
      "first\r\nsecond\r\n",
      "utf-8"
    );

    const result = await migratePackageToSeries({
      cwd,
      name: NAME,
      pristineRoot: pristine,
    });

    const seriesResult = nodePath.join(cwd, "series-result");
    await applySeries({
      pristineRoot: pristine,
      seriesDir: seriesDirPath(cwd, NAME),
      targetRoot: seriesResult,
    });
    expect(
      await readFile(nodePath.join(seriesResult, "crlf.txt"), "utf-8")
    ).toBe("first\r\nsecond\r\n");
    expect(result.droppedEmptyDirectories).toEqual([]);
  });

  test("reports empty directories the patch series cannot record", async () => {
    // Deleting every file in docs/ by hand leaves an empty directory behind.
    await mkdir(overlayRoot, { recursive: true });
    await writeFile(
      nodePath.join(overlayRoot, ".inrepo-deletions"),
      "docs/faq.md\ndocs/guide.md\n",
      "utf-8"
    );

    const result = await migratePackageToSeries({
      cwd,
      name: NAME,
      pristineRoot: pristine,
    });
    expect(result.droppedEmptyDirectories).toEqual(["docs"]);
    expect(await readdir(overlayRoot)).toEqual(["series"]);
  });

  test("refuses to migrate an overlay that no longer differs from upstream", async () => {
    await mkdir(nodePath.join(overlayRoot, "src"), { recursive: true });
    await writeFile(
      nodePath.join(overlayRoot, "src", "index.ts"),
      "export const value = 1;\n",
      "utf-8"
    );

    await expect(
      migratePackageToSeries({ cwd, name: NAME, pristineRoot: pristine })
    ).rejects.toThrow(
      /No differences between the upstream tree and the patched tree/u
    );
    expect(existsSync(seriesDirPath(cwd, NAME))).toBe(false);
    expect(existsSync(nodePath.join(overlayRoot, "src", "index.ts"))).toBe(
      true
    );
  });

  test("refuses to migrate a package that already has a series", async () => {
    await writeLegacyOverlay();
    await mkdir(seriesDirPath(cwd, NAME), { recursive: true });
    await writeFile(
      nodePath.join(seriesDirPath(cwd, NAME), "0001-existing.patch"),
      "",
      "utf-8"
    );

    await expect(
      migratePackageToSeries({ cwd, name: NAME, pristineRoot: pristine })
    ).rejects.toThrow(/already has a patch series/u);
    expect(existsSync(nodePath.join(overlayRoot, "src", "index.ts"))).toBe(
      true
    );
  });

  test("refuses to migrate a package with no legacy overlay", async () => {
    await rm(overlayRoot, { force: true, recursive: true });
    await expect(
      migratePackageToSeries({ cwd, name: NAME, pristineRoot: pristine })
    ).rejects.toThrow(/No legacy overlay to migrate/u);
  });
});
