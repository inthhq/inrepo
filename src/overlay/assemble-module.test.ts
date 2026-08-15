import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { RewirePlan } from "../rewire/rewire-tree.js";
import { formatSeriesPatch } from "../series/format-series-patch.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { assembleModuleTree, assemblePatchedTree } from "./assemble-module.js";
import { overlayDirPath, seriesDirPath } from "./overlay-paths.js";
import { copyTree } from "./tree-utils.js";

const NAME = "upstream";

describe("assemblePatchedTree", () => {
  let cwd: string;
  let pristine: string;
  let overlayRoot: string;
  let target: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-assemble-");
    pristine = nodePath.join(cwd, "pristine");
    overlayRoot = overlayDirPath(cwd, NAME);
    target = nodePath.join(cwd, "target");

    await mkdir(nodePath.join(pristine, "src"), { recursive: true });
    await mkdir(nodePath.join(pristine, "docs"), { recursive: true });
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
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const writeLegacyOverlay =
    async function writeLegacyOverlay(): Promise<void> {
      await mkdir(nodePath.join(overlayRoot, "src"), { recursive: true });
      await writeFile(
        nodePath.join(overlayRoot, "src", "index.ts"),
        "export const value = 2;\n",
        "utf-8"
      );
      await writeFile(
        nodePath.join(overlayRoot, ".inrepo-deletions"),
        "docs/guide.md\n",
        "utf-8"
      );
    };

  const writeSeries = async function writeSeries(): Promise<void> {
    const patched = nodePath.join(cwd, "patched");
    await copyTree(pristine, patched);
    await writeFile(
      nodePath.join(patched, "src", "index.ts"),
      "export const value = 3;\n",
      "utf-8"
    );
    await rm(nodePath.join(patched, "docs", "faq.md"));

    const patch = await formatSeriesPatch({
      baseRoot: pristine,
      patchedRoot: patched,
      startNumber: 1,
      subject: "Set value to three",
    });
    await mkdir(seriesDirPath(cwd, NAME), { recursive: true });
    await writeFile(
      nodePath.join(seriesDirPath(cwd, NAME), patch.fileName),
      patch.content
    );
  };

  test("uses the legacy overlay when no series exists", async () => {
    await writeLegacyOverlay();

    await assemblePatchedTree({
      cwd,
      name: NAME,
      pristineRoot: pristine,
      targetRoot: target,
    });

    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 2;\n");
    expect(existsSync(nodePath.join(target, "docs", "guide.md"))).toBe(false);
    expect(existsSync(nodePath.join(target, "docs", "faq.md"))).toBe(true);
  });

  test("uses the series when one exists and ignores leftover overlay files", async () => {
    await writeLegacyOverlay();
    await writeSeries();

    await assemblePatchedTree({
      cwd,
      name: NAME,
      pristineRoot: pristine,
      targetRoot: target,
    });

    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 3;\n");
    expect(existsSync(nodePath.join(target, "docs", "guide.md"))).toBe(true);
    expect(existsSync(nodePath.join(target, "docs", "faq.md"))).toBe(false);
    expect(existsSync(nodePath.join(target, "series"))).toBe(false);
  });

  test("rewires imports in the generated tree but never in the patched tree", async () => {
    await writeFile(
      nodePath.join(pristine, "src", "index.ts"),
      'import dep from "dep";\n',
      "utf-8"
    );
    const depRoot = nodePath.join(cwd, "inrepo_modules", "dep");
    await mkdir(depRoot, { recursive: true });
    await writeFile(
      nodePath.join(depRoot, "package.json"),
      '{"name":"dep","main":"main.js"}',
      "utf-8"
    );
    await writeFile(
      nodePath.join(depRoot, "main.js"),
      "export default 1;\n",
      "utf-8"
    );

    const rewire: RewirePlan = {
      dependencies: new Map([
        [
          "dep",
          {
            manifest: { exports: undefined, main: "main.js", module: null },
            modulePath: "dep",
            root: depRoot,
          },
        ],
      ]),
      modulePath: NAME,
      name: NAME,
    };

    await assemblePatchedTree({
      cwd,
      name: NAME,
      pristineRoot: pristine,
      targetRoot: target,
    });
    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe('import dep from "dep";\n');

    const generated = nodePath.join(cwd, "generated");
    let reported = 0;
    await assembleModuleTree({
      commit: "a".repeat(40),
      cwd,
      gitUrl: "https://example.com/upstream.git",
      name: NAME,
      onRewire: (report) => {
        reported = report.specifiers;
      },
      pristineRoot: pristine,
      rewire,
      targetRoot: generated,
    });

    expect(reported).toBe(1);
    expect(
      await readFile(nodePath.join(generated, "src", "index.ts"), "utf-8")
    ).toBe('import dep from "../../dep/main.js";\n');
    expect(existsSync(nodePath.join(generated, ".inrepo-vendor.json"))).toBe(
      true
    );
  });

  test("leaves the generated tree alone when rewiring is switched off", async () => {
    await writeFile(
      nodePath.join(pristine, "src", "index.ts"),
      'import dep from "dep";\n',
      "utf-8"
    );
    const generated = nodePath.join(cwd, "generated");

    await assembleModuleTree({
      commit: "a".repeat(40),
      cwd,
      gitUrl: "https://example.com/upstream.git",
      name: NAME,
      pristineRoot: pristine,
      rewire: null,
      targetRoot: generated,
    });

    expect(
      await readFile(nodePath.join(generated, "src", "index.ts"), "utf-8")
    ).toBe('import dep from "dep";\n');
  });

  test("never copies the series directory into the patched tree", async () => {
    await writeLegacyOverlay();
    await mkdir(seriesDirPath(cwd, NAME), { recursive: true });
    await writeFile(
      nodePath.join(seriesDirPath(cwd, NAME), "notes.txt"),
      "not a patch\n",
      "utf-8"
    );

    await assemblePatchedTree({
      cwd,
      name: NAME,
      pristineRoot: pristine,
      targetRoot: target,
    });

    expect(existsSync(nodePath.join(target, "series"))).toBe(false);
    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe("export const value = 2;\n");
  });
});
