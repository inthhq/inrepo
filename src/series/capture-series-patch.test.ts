import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { seriesDirPath } from "../overlay/overlay-paths.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { applySeries } from "./apply-series.js";
import { captureSeriesPatch } from "./capture-series-patch.js";
import { comparePatchedTrees } from "./compare-patched-trees.js";
import { readPatchHeader } from "./read-patch-header.js";
import { readSeries } from "./read-series.js";

const AUTHOR = { email: "test@example.com", name: "Test Author" };

describe("captureSeriesPatch", () => {
  let cwd: string;
  let pristine: string;
  let module: string;
  let seriesDir: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-capture-");
    pristine = nodePath.join(cwd, "pristine");
    module = nodePath.join(cwd, "inrepo_modules", "upstream");
    seriesDir = seriesDirPath(cwd, "upstream");

    await mkdir(nodePath.join(pristine, "src"), { recursive: true });
    await writeFile(
      nodePath.join(pristine, "src", "index.ts"),
      "export const v = 1;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(pristine, "README.md"),
      "# upstream\n",
      "utf-8"
    );
    // Cache metadata sits next to a real pristine checkout and must stay out of
    // the patch surface.
    await writeFile(
      nodePath.join(pristine, ".cache-meta.json"),
      "{}\n",
      "utf-8"
    );

    await mkdir(nodePath.join(module, "src"), { recursive: true });
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 1;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(module, "README.md"),
      "# upstream\n",
      "utf-8"
    );
    // The generated marker sync writes into inrepo_modules must not be captured.
    await writeFile(
      nodePath.join(module, ".inrepo-vendor.json"),
      '{"commit":"abc"}\n',
      "utf-8"
    );
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const capture = function capture(subject: string) {
    return captureSeriesPatch({
      author: AUTHOR,
      cwd,
      moduleRoot: module,
      name: "upstream",
      pristineRoot: pristine,
      subject,
    });
  };

  test("reports nothing to capture when the module matches the patched tree", async () => {
    expect(await capture("No-op")).toEqual({ captured: false });
    expect(existsSync(seriesDir)).toBe(false);
  });

  test("ignores the generated vendor marker and cache metadata", async () => {
    await writeFile(
      nodePath.join(module, ".inrepo-vendor.json"),
      '{"commit":"changed"}\n',
      "utf-8"
    );
    expect(await capture("No-op")).toEqual({ captured: false });
  });

  test("writes the first capture as 0001 with the message as the subject", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );

    const result = await capture("Bump the exported version");
    expect(result.captured).toBe(true);
    if (!result.captured) {
      throw new Error("unreachable");
    }

    expect(result.number).toBe(1);
    expect(result.patchFileName).toBe("0001-Bump-the-exported-version.patch");
    expect(await readdir(seriesDir)).toEqual([
      "0001-Bump-the-exported-version.patch",
    ]);

    const header = await readPatchHeader((await readSeries(seriesDir))[0]);
    expect(header.subject).toBe("Bump the exported version");
    expect(header.authorName).toBe("Test Author");
    expect(header.authorEmail).toBe("test@example.com");
    expect(header.files).toEqual(["src/index.ts"]);
  });

  test("replaying the captured series reproduces the module tree", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(module, "src", "local.ts"),
      "export const local = true;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(module, "logo.bin"),
      new Uint8Array([9, 8, 7, 6])
    );
    await rm(nodePath.join(module, "README.md"));

    expect((await capture("Capture edits")).captured).toBe(true);

    const replayed = nodePath.join(cwd, "replayed");
    await applySeries({
      pristineRoot: pristine,
      seriesDir,
      targetRoot: replayed,
    });
    expect((await comparePatchedTrees(replayed, module)).differences).toEqual(
      []
    );
  });

  test("numbers sequential captures and records only the new delta", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    expect((await capture("First change")).captured).toBe(true);

    await writeFile(
      nodePath.join(module, "src", "other.ts"),
      "export const other = 1;\n",
      "utf-8"
    );
    const second = await capture("Second change");
    if (!second.captured) {
      throw new Error("unreachable");
    }
    expect(second.number).toBe(2);

    await writeFile(nodePath.join(module, "README.md"), "# patched\n", "utf-8");
    const third = await capture("Third change");
    if (!third.captured) {
      throw new Error("unreachable");
    }
    expect(third.number).toBe(3);

    expect(await (await readdir(seriesDir)).toSorted()).toEqual([
      "0001-First-change.patch",
      "0002-Second-change.patch",
      "0003-Third-change.patch",
    ]);

    const headers = [];
    for (const patch of await readSeries(seriesDir)) {
      headers.push(await readPatchHeader(patch));
    }
    expect(headers.map((header) => header.files)).toEqual([
      ["src/index.ts"],
      ["src/other.ts"],
      ["README.md"],
    ]);

    const replayed = nodePath.join(cwd, "replayed");
    await applySeries({
      pristineRoot: pristine,
      seriesDir,
      targetRoot: replayed,
    });
    expect((await comparePatchedTrees(replayed, module)).differences).toEqual(
      []
    );
  });

  test("captures nothing when a later run reverts back to the patched tree", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    expect((await capture("First change")).captured).toBe(true);
    expect(await capture("Nothing new")).toEqual({ captured: false });
    expect((await readdir(seriesDir)).length).toBe(1);
  });

  test("rejects an empty message", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    await expect(capture("   ")).rejects.toThrow(/without a patch message/u);
  });

  test("falls back to a usable file name when the subject has no slug", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    const result = await capture("...");
    if (!result.captured) {
      throw new Error("unreachable");
    }
    expect(result.patchFileName).toBe("0001-patch.patch");
    expect(
      await (await readSeries(seriesDir)).map((patch) => patch.fileName)
    ).toEqual(["0001-patch.patch"]);
  });

  test("reports empty directories git cannot record", async () => {
    await mkdir(nodePath.join(module, "generated"), { recursive: true });
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );

    const result = await capture("Add an empty directory");
    if (!result.captured) {
      throw new Error("unreachable");
    }
    expect(result.droppedEmptyDirectories).toEqual(["generated"]);
  });

  test("records the patch as standard format-patch output", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    const result = await capture("Bump the exported version");
    if (!result.captured) {
      throw new Error("unreachable");
    }

    const content = await readFile(result.patchPath, "utf-8");
    expect(content).toMatch(/^From /u);
    expect(content).toContain("From: Test Author <test@example.com>");
    expect(content).toContain("Subject: [PATCH] Bump the exported version");
    expect(content).not.toContain(".inrepo-vendor.json");
    expect(content).not.toContain(".cache-meta.json");
  });

  test("refuses a new ../ symlink and does not write a patch file", async () => {
    await symlink("../../etc/passwd", nodePath.join(module, "escape-link"));

    await expect(capture("Add an escaping symlink")).rejects.toThrow(
      /Refusing to apply symlink escaping module root at "escape-link"/u
    );
    expect(existsSync(seriesDir)).toBe(false);
  });

  test("refuses a new absolute symlink and does not write a patch file", async () => {
    await symlink("/tmp/inrepo-abs-target", nodePath.join(module, "abs-link"));

    await expect(capture("Add an absolute symlink")).rejects.toThrow(
      /Refusing to apply absolute symlink target at "abs-link"/u
    );
    expect(existsSync(seriesDir)).toBe(false);
  });

  test("allows an unchanged upstream symlink when capturing a file edit", async () => {
    await symlink("../../etc/passwd", nodePath.join(pristine, "escape-link"));
    await symlink("../../etc/passwd", nodePath.join(module, "escape-link"));
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );

    const result = await capture("Bump the exported version");
    expect(result.captured).toBe(true);
    if (!result.captured) {
      throw new Error("unreachable");
    }
    expect(result.patchFileName).toBe("0001-Bump-the-exported-version.patch");
    expect(existsSync(result.patchPath)).toBe(true);

    const header = await readPatchHeader((await readSeries(seriesDir))[0]);
    expect(header.files).toEqual(["src/index.ts"]);
  });

  test("still captures a normal file edit", async () => {
    await writeFile(
      nodePath.join(module, "src", "index.ts"),
      "export const v = 7;\n",
      "utf-8"
    );

    const result = await capture("Tweak the exported version");
    expect(result.captured).toBe(true);
    if (!result.captured) {
      throw new Error("unreachable");
    }
    expect(result.patchFileName).toBe("0001-Tweak-the-exported-version.patch");
    expect(
      await readFile(nodePath.join(module, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 7;\n");
    expect(existsSync(result.patchPath)).toBe(true);
  });
});
