import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";

import { overlayDirPath, seriesDirPath } from "../overlay/overlay-paths.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { migratePackageToSeries } from "./migrate-package.js";

vi.mock("./compare-patched-trees.js", () => ({
  comparePatchedTrees: () => ({
    differences: ["content changed: src/index.ts"],
    droppedEmptyDirectories: [],
  }),
}));

const NAME = "upstream";

/**
 * Migration only removes the legacy overlay once the generated series
 * reproduces the identical tree. Nothing an overlay can express currently
 * survives that round trip incorrectly, so the mismatch is forced here to keep
 * the rollback path covered.
 */
describe("migratePackageToSeries verification failure", () => {
  let cwd: string;
  let pristine: string;
  let overlayRoot: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-series-rollback-");
    pristine = nodePath.join(cwd, ".inrepo", "cache", NAME);
    overlayRoot = overlayDirPath(cwd, NAME);

    await mkdir(nodePath.join(pristine, "src"), { recursive: true });
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
    await symlink("./README.md", nodePath.join(pristine, "readme-link"));

    await mkdir(nodePath.join(overlayRoot, "src"), { recursive: true });
    await writeFile(
      nodePath.join(overlayRoot, "src", "index.ts"),
      "export const value = 42;\n",
      "utf-8"
    );
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("leaves the legacy overlay untouched and reports the mismatch", async () => {
    await expect(
      migratePackageToSeries({ cwd, name: NAME, pristineRoot: pristine })
    ).rejects.toThrow(
      /did not reproduce the overlay result: patched trees differ \(content changed: src\/index\.ts\)\. The legacy overlay was left unchanged\./u
    );

    expect(existsSync(seriesDirPath(cwd, NAME))).toBe(false);
    expect(
      await readFile(nodePath.join(overlayRoot, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 42;\n");
  });
});
