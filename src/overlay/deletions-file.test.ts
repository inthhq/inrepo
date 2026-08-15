import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import {
  normalizeDeletionEntries,
  parseDeletionsFile,
  readDeletionsFile,
  serializeDeletionsFile,
  writeDeletionsFile,
} from "./deletions-file.js";

describe("deletions-file", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-deletions-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("parses comments, blanks, and sorts entries", () => {
    expect(
      parseDeletionsFile(`
# comment

src/old.ts
docs/
`)
    ).toEqual(["docs/", "src/old.ts"]);
  });

  test("rejects unsafe paths", () => {
    expect(() => normalizeDeletionEntries(["../escape"])).toThrow(
      /normal relative path/u
    );
    expect(() => normalizeDeletionEntries(["/abs/path"])).toThrow(
      /must be relative/u
    );
    expect(() => normalizeDeletionEntries(["C:\\temp"])).toThrow(
      /must be relative/u
    );
  });

  test("writes deterministic contents and round-trips", async () => {
    const path = nodePath.join(
      cwd,
      "inrepo_patches",
      "foo",
      ".inrepo-deletions"
    );
    await writeDeletionsFile(path, ["src/old.ts", "docs/"]);
    expect(await readFile(path, "utf-8")).toBe("docs/\nsrc/old.ts\n");
    expect(await readDeletionsFile(path)).toEqual(["docs/", "src/old.ts"]);
    expect(serializeDeletionsFile(["src/old.ts", "docs/"])).toBe(
      "docs/\nsrc/old.ts\n"
    );
  });

  test("removes the deletions file when entries are empty", async () => {
    const path = nodePath.join(
      cwd,
      "inrepo_patches",
      "foo",
      ".inrepo-deletions"
    );
    await writeDeletionsFile(path, ["docs/"]);
    await writeDeletionsFile(path, []);
    expect(await readDeletionsFile(path)).toEqual([]);
  });
});
