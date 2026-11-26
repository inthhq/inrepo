import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import {
  bootstrapHostPackageJson,
  envFor,
  writeConfig,
} from "../test-utils/e2e-harness.js";
import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import { runCli } from "../test-utils/run-cli.js";
import type { RunCliResult } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const MODE = "inrepo.json";

/** stdout under `--json` must be exactly one JSON document. */
const envelope = function envelope(result: RunCliResult): JsonObject {
  // SAFETY: the CLI contract under --json is a single JSON object on stdout.
  return JSON.parse(result.stdout) as JsonObject;
};

/**
 * Every path under `root` with a content fingerprint, except the download
 * cache, which `--dry-run` is allowed to fill.
 */
const snapshotProject = async function snapshotProject(
  root: string
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const cache = nodePath.join(".inrepo", "cache");
  for (const rel of (await readdir(root, { recursive: true })).toSorted()) {
    if (rel === cache || rel.startsWith(`${cache}${nodePath.sep}`)) {
      continue;
    }
    const abs = nodePath.join(root, rel);
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      snapshot.set(rel, `symlink:${await readlink(abs)}`);
    } else if (info.isDirectory()) {
      snapshot.set(rel, "dir");
    } else {
      const hash = createHash("sha256")
        .update(await readFile(abs))
        .digest("hex");
      snapshot.set(rel, `file:${info.mode.toString(8)}:${hash}`);
    }
  }
  return snapshot;
};

/** The first entry of a `{ packages: [...] }` result. */
const firstPackage = function firstPackage(result: RunCliResult): JsonObject {
  // SAFETY: patch and diff results are `{ packages: object[] }` on success.
  const { packages } = envelope(result).data as { packages: JsonObject[] };
  expect(packages.length).toBeGreaterThan(0);
  return packages[0];
};

describe("CLI: --json for patch, diff, and migrate (e2e)", () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let overlayDir: string;
  let seriesDir: string;

  const cli = function cli(args: string[]): Promise<RunCliResult> {
    return runCli(args, { cwd, env: envFor(MODE) });
  };

  beforeAll(async () => {
    fx = await makeLocalGitFixture("inrepo-json-patch-");
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-json-patch-e2e-");
    moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
    overlayDir = nodePath.join(cwd, "inrepo_patches", "upstream");
    seriesDir = nodePath.join(overlayDir, "series");
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, MODE, {
      packages: [{ git: fx.url, name: "upstream" }],
    });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const syncAndEdit = async function syncAndEdit(): Promise<void> {
    expect((await cli(["sync"])).exitCode).toBe(0);
    await writeFile(
      nodePath.join(moduleDir, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(moduleDir, "src", "local.ts"),
      "export const local = true;\n",
      "utf-8"
    );
    await rm(nodePath.join(moduleDir, "docs", "guide.md"));
  };

  const expectedFiles = [
    { path: "docs/guide.md", status: "deleted" },
    { path: "src/index.ts", status: "modified" },
    { path: "src/local.ts", status: "added" },
  ];

  test("patch --json reports the appended patch and its files", async () => {
    await syncAndEdit();

    const r = await cli(["patch", "upstream", "-m", "Bump v", "--json"]);
    expect(r.exitCode).toBe(0);
    const out = envelope(r);
    expect(out).toMatchObject({ command: "patch", ok: true });
    expect(out.data).toEqual({
      packages: [
        {
          captured: true,
          files: expectedFiles,
          format: "series",
          module: "upstream",
          patch: {
            file: "inrepo_patches/upstream/series/0001-Bump-v.patch",
            number: 1,
            subject: "Bump v",
          },
        },
      ],
    });
    expect(existsSync(nodePath.join(seriesDir, "0001-Bump-v.patch"))).toBe(
      true
    );

    const again = await cli(["patch", "upstream", "-m", "Again", "--json"]);
    expect(again.exitCode).toBe(0);
    expect(envelope(again).data).toEqual({
      packages: [
        { captured: false, files: [], format: "series", module: "upstream" },
      ],
    });
  });

  test("patch without -m under --json is a usage error with a next command", async () => {
    await syncAndEdit();

    const r = await cli(["patch", "upstream", "--json"]);
    expect(r.exitCode).toBe(2);
    const out = envelope(r);
    expect(out).toMatchObject({
      command: "patch",
      error: {
        code: "USAGE",
        nextCommand: 'inrepo patch upstream -m "<reason>"',
      },
      ok: false,
    });
    expect(existsSync(seriesDir)).toBe(false);
  });

  test("patch --dry-run reports the would-be capture and writes nothing", async () => {
    await syncAndEdit();
    const before = await snapshotProject(cwd);

    const named = await cli([
      "patch",
      "upstream",
      "-m",
      "Bump v",
      "--dry-run",
      "--json",
    ]);
    expect(named.exitCode).toBe(0);
    const out = envelope(named);
    expect(out).toMatchObject({ command: "patch", dryRun: true, ok: true });
    expect(out.data).toEqual({
      packages: [
        {
          captured: true,
          files: expectedFiles,
          format: "series",
          module: "upstream",
          patch: {
            file: "inrepo_patches/upstream/series/0001-Bump-v.patch",
            number: 1,
            subject: "Bump v",
          },
        },
      ],
    });

    // A preview does not need a reason yet; the file name is then unknown.
    const unnamed = await cli(["patch", "upstream", "--dry-run", "--json"]);
    expect(unnamed.exitCode).toBe(0);
    expect(envelope(unnamed).data).toMatchObject({
      packages: [
        {
          captured: true,
          patch: { file: null, number: 1, subject: null },
        },
      ],
    });

    expect(existsSync(overlayDir)).toBe(false);
    expect(await snapshotProject(cwd)).toEqual(before);
  });

  test("patch --dry-run on a legacy overlay package writes nothing", async () => {
    await mkdir(nodePath.join(overlayDir, "src"), { recursive: true });
    await writeFile(
      nodePath.join(overlayDir, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    expect((await cli(["sync"])).exitCode).toBe(0);
    await writeFile(
      nodePath.join(moduleDir, "src", "local.ts"),
      "export const local = true;\n",
      "utf-8"
    );
    const before = await snapshotProject(cwd);

    const r = await cli(["patch", "upstream", "--dry-run", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(envelope(r)).toMatchObject({
      data: {
        packages: [
          {
            captured: true,
            files: [
              { path: "src/index.ts", status: "modified" },
              { path: "src/local.ts", status: "added" },
            ],
            format: "overlay",
            module: "upstream",
          },
        ],
      },
      dryRun: true,
      ok: true,
    });
    expect(await snapshotProject(cwd)).toEqual(before);
  });

  test("diff --json carries patches, per-file stats, and the unified diff", async () => {
    await syncAndEdit();
    expect((await cli(["patch", "upstream", "-m", "Bump v"])).exitCode).toBe(0);

    const r = await cli(["diff", "upstream", "--json"]);
    expect(r.exitCode).toBe(0);
    const out = envelope(r);
    expect(out).toMatchObject({ command: "diff", ok: true });
    expect(out.data).toMatchObject({
      packages: [
        {
          files: [
            { additions: 0, path: "docs/guide.md", status: "deleted" },
            {
              additions: 1,
              deletions: 1,
              path: "src/index.ts",
              status: "modified",
            },
            {
              additions: 1,
              deletions: 0,
              path: "src/local.ts",
              status: "added",
            },
          ],
          module: "upstream",
          patches: [
            {
              file: "inrepo_patches/upstream/series/0001-Bump-v.patch",
              number: 1,
              subject: "Bump v",
            },
          ],
          source: "series",
        },
      ],
    });
    const pkg = firstPackage(r);
    expect(pkg.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(pkg.diff).toContain("+export const v = 99;");

    const stat = await cli(["diff", "upstream", "--stat", "--json"]);
    expect(stat.exitCode).toBe(0);
    const statPkg = firstPackage(stat);
    expect(statPkg).not.toHaveProperty("diff");
    expect(statPkg.files).toHaveLength(3);
  });

  test("diff --json reports a patch that no longer applies", async () => {
    await syncAndEdit();
    expect((await cli(["patch", "upstream", "-m", "Bump v"])).exitCode).toBe(0);
    const patchPath = nodePath.join(seriesDir, "0001-Bump-v.patch");
    // Expect a preimage upstream never had, and drop the blob ids a 3-way
    // apply would otherwise fall back on.
    const content = await readFile(patchPath, "utf-8");
    await writeFile(
      patchPath,
      content
        .replace(/^-export const v = \d+;$/mu, "-export const v = 12345;")
        .replaceAll(
          /^index [0-9a-f]+\.\.[0-9a-f]+/gmu,
          `index ${"1".repeat(40)}..${"2".repeat(40)}`
        ),
      "utf-8"
    );

    const r = await cli(["diff", "upstream", "--json"]);
    expect(r.exitCode).toBe(3);
    expect(envelope(r)).toMatchObject({
      error: {
        code: "PATCH_APPLY_FAILED",
        details: {
          file: patchPath,
          package: "upstream",
          patch: "0001-Bump-v.patch",
        },
      },
      ok: false,
    });
  });

  test("migrate --json reports the generated series", async () => {
    await mkdir(nodePath.join(overlayDir, "src"), { recursive: true });
    await writeFile(
      nodePath.join(overlayDir, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    expect((await cli(["sync"])).exitCode).toBe(0);

    const r = await cli(["migrate", "upstream", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(envelope(r)).toMatchObject({
      command: "migrate",
      data: {
        droppedEmptyDirectories: [],
        files: [{ path: "src/index.ts", status: "modified" }],
        module: "upstream",
        patches: [
          {
            file: "inrepo_patches/upstream/series/0001-Import-legacy-inrepo-overlay-for-upstream.patch",
            number: 1,
            subject: "Import legacy inrepo overlay for upstream",
          },
        ],
        removedOverlayEntries: ["src"],
      },
      ok: true,
    });

    const again = await cli(["migrate", "upstream", "--json"]);
    expect(again.exitCode).toBe(2);
    expect(envelope(again)).toMatchObject({
      error: { code: "USAGE" },
      ok: false,
    });

    const unknown = await cli(["migrate", "nope", "--json"]);
    expect(unknown.exitCode).toBe(2);
    expect(envelope(unknown)).toMatchObject({
      error: { code: "PACKAGE_NOT_FOUND", details: { package: "nope" } },
      ok: false,
    });
  });

  test("an unknown option is a usage error", async () => {
    for (const command of ["patch", "diff", "migrate"]) {
      const r = await cli([command, "upstream", "--bogus", "--json"]);
      expect(r.exitCode).toBe(2);
      expect(envelope(r)).toMatchObject({
        command,
        error: { code: "USAGE", message: "Unknown option: --bogus" },
        ok: false,
      });
    }
  });
});
