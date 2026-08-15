import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import {
  decodeHeaderValue,
  parsePatchHeader,
  readSeriesHeaders,
  unquoteGitPath,
} from "./read-patch-header.js";

const PATCH_REF = {
  fileName: "0002-tighten-jsdoc-types.patch",
  index: 2,
  path: "/tmp/x.patch",
};

const PATCH = [
  "From 9f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3 Mon Sep 17 00:00:00 2001",
  "From: Kaylee Williams <kaylee@example.com>",
  "Date: Tue, 11 Aug 2026 09:15:00 +0000",
  "Subject: [PATCH] Tighten JSDoc types",
  "",
  "Upstream annotates the return type too loosely.",
  "---",
  " src/index.ts  | 2 +-",
  " docs/guide.md | 1 -",
  " 2 files changed, 1 insertion(+), 2 deletions(-)",
  "",
  "diff --git a/src/index.ts b/src/index.ts",
  "index 1111111..2222222 100644",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,2 +1,2 @@",
  // A removed line whose own content starts with "--" renders as "--- …" and
  // must not be mistaken for a diff header.
  "--- legacy note",
  "+-- new note",
  "diff --git a/docs/guide.md b/docs/guide.md",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/docs/guide.md",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-# guide",
  "diff --git a/bin/run.sh b/bin/run.sh",
  "old mode 100644",
  "new mode 100755",
  "diff --git a/logo.bin b/logo.bin",
  "index 4444444..5555555 100644",
  "GIT binary patch",
  "literal 4",
  "Lc$_OaWCVWA1poj5",
  "",
  "literal 0",
  "Hc$@<O00001",
  "",
].join("\n");

describe("parsePatchHeader", () => {
  test("reads provenance out of a git format-patch file", () => {
    const header = parsePatchHeader(PATCH_REF, PATCH);

    expect(header.commit).toBe("9f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3");
    expect(header.authorName).toBe("Kaylee Williams");
    expect(header.authorEmail).toBe("kaylee@example.com");
    expect(header.date).toBe("Tue, 11 Aug 2026 09:15:00 +0000");
    expect(header.subject).toBe("Tighten JSDoc types");
    expect(header.fileName).toBe("0002-tighten-jsdoc-types.patch");
    expect(header.index).toBe(2);
  });

  test("lists affected files across modifications, deletions, modes, and binaries", () => {
    expect(parsePatchHeader(PATCH_REF, PATCH).files).toEqual([
      "src/index.ts",
      "docs/guide.md",
      "bin/run.sh",
      "logo.bin",
    ]);
  });

  test("takes the new path for a rename", () => {
    const patch = [
      "From: a <a@b>",
      "Subject: [PATCH] Move it",
      "",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parsePatchHeader(PATCH_REF, patch).files).toEqual(["src/new.ts"]);
  });

  test("unquotes paths git escaped", () => {
    const patch = [
      "Subject: [PATCH] Non-ASCII path",
      "",
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    expect(parsePatchHeader(PATCH_REF, patch).files).toEqual(["src/café.ts"]);
  });

  test("joins a subject git folded across lines", () => {
    const patch = [
      "Subject: [PATCH] Restate the unsupported standard library operations that",
      " scriptc cannot compile",
      "",
    ].join("\n");

    expect(parsePatchHeader(PATCH_REF, patch).subject).toBe(
      "Restate the unsupported standard library operations that scriptc cannot compile"
    );
  });

  test("decodes an encoded subject", () => {
    const patch = ["Subject: [PATCH] =?UTF-8?q?Caf=C3=A9=20fix?=", ""].join(
      "\n"
    );
    expect(parsePatchHeader(PATCH_REF, patch).subject).toBe("Café fix");
  });

  test("keeps numbered PATCH prefixes out of the subject", () => {
    const patch = ["Subject: [PATCH 2/7] Second change", ""].join("\n");
    expect(parsePatchHeader(PATCH_REF, patch).subject).toBe("Second change");
  });
});

describe("decodeHeaderValue", () => {
  test("decodes quoted-printable and base64 encoded words", () => {
    expect(decodeHeaderValue("=?UTF-8?q?caf=C3=A9?=")).toBe("café");
    expect(decodeHeaderValue("=?UTF-8?b?Y2Fmw6k=?=")).toBe("café");
    expect(decodeHeaderValue("plain text")).toBe("plain text");
  });
});

describe("unquoteGitPath", () => {
  test("decodes octal escapes and leaves plain paths alone", () => {
    expect(unquoteGitPath('"src/caf\\303\\251.ts"')).toBe("src/café.ts");
    expect(unquoteGitPath('"a\\tb"')).toBe("a\tb");
    expect(unquoteGitPath("src/index.ts")).toBe("src/index.ts");
  });
});

describe("readSeriesHeaders", () => {
  let cwd: string;
  let seriesDir: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-patch-header-");
    seriesDir = nodePath.join(cwd, "series");
    await mkdir(seriesDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("returns the series in apply order", async () => {
    await writeFile(
      nodePath.join(seriesDir, "0002-second.patch"),
      "Subject: [PATCH] Second\n\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(seriesDir, "0001-first.patch"),
      "Subject: [PATCH] First\n\n",
      "utf-8"
    );

    const headers = await readSeriesHeaders(seriesDir);
    expect(headers.map((header) => header.subject)).toEqual([
      "First",
      "Second",
    ]);
    expect(headers.map((header) => header.index)).toEqual([1, 2]);
    expect(headers[0].path).toBe(nodePath.join(seriesDir, "0001-first.patch"));
  });

  test("returns an empty list when there is no series", async () => {
    expect(await readSeriesHeaders(nodePath.join(cwd, "nope"))).toEqual([]);
  });
});
