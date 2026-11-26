import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { JsonObject, JsonValue } from "../json/unknown.js";
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

interface Envelope {
  ok: boolean;
  command: string;
  data?: JsonObject;
  error?: { code: string; message: string; details?: JsonObject };
}

/** Parse the single JSON document `--json` prints on stdout. */
const envelope = function envelope(result: RunCliResult): Envelope {
  // SAFETY: --json prints exactly one envelope object on stdout.
  return JSON.parse(result.stdout) as Envelope;
};

/** Every path under `root` with a content hash, so any write is visible. */
const snapshotTree = async function snapshotTree(
  root: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = nodePath.join(dir, entry.name);
      const rel = nodePath.relative(root, abs);
      if (entry.isDirectory()) {
        out.set(rel, "dir");
        await walk(abs);
      } else if (entry.isFile()) {
        out.set(
          rel,
          createHash("sha256")
            .update(await readFile(abs))
            .digest("hex")
        );
      } else {
        out.set(rel, "other");
      }
    }
  };
  await walk(root);
  return out;
};

describe("CLI: status (e2e)", () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let updateRepo: string;

  beforeEach(async () => {
    fx = await makeLocalGitFixture("inrepo-status-");
    cwd = await makeTmpDir("inrepo-status-e2e-");
    moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
    updateRepo = nodePath.join(cwd, ".inrepo", "updates", "upstream", "repo");
    await bootstrapHostPackageJson(cwd);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
    await fx.cleanup();
  });

  const cli = async function cli(args: string[]): Promise<RunCliResult> {
    return await runCli(args, { cwd, env: envFor(MODE) });
  };

  const configure = async function configure(): Promise<void> {
    await writeConfig(cwd, MODE, {
      packages: [{ git: fx.url, name: "upstream", ref: "main" }],
    });
  };

  const statusJson = async function statusJson(
    args: string[] = []
  ): Promise<JsonObject> {
    const result = await cli(["status", ...args, "--json"]);
    expect(result.exitCode).toBe(0);
    const env = envelope(result);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("status");
    return env.data ?? {};
  };

  const onlyPackage = async function onlyPackage(): Promise<JsonObject> {
    const data = await statusJson();
    // SAFETY: status data always carries a packages array.
    const packages = data.packages as JsonObject[];
    expect(packages).toHaveLength(1);
    return packages[0];
  };

  test("a project without config reports nothing vendored and points at init", async () => {
    const data = await statusJson();
    expect(data).toEqual({
      configPath: null,
      lockfilePath: null,
      nextActions: ["inrepo init"],
      packages: [],
    });
  });

  test("a configured package that was never synced is not locked yet", async () => {
    await configure();
    const data = await statusJson();
    expect(data.configPath).toBe("inrepo.json");
    expect(data.lockfilePath).toBeNull();
    expect(data.nextActions).toEqual(["inrepo sync"]);
    // SAFETY: status data always carries a packages array.
    const [pkg] = data.packages as JsonObject[];
    expect(pkg).toMatchObject({
      commit: null,
      condition: "not-locked",
      configured: true,
      dev: false,
      git: fx.url,
      module: "upstream",
      name: "upstream",
      nextActions: ["inrepo sync"],
      ref: "main",
      update: null,
    });
    expect(pkg.checkout).toMatchObject({
      path: "inrepo_modules/upstream",
      present: false,
    });
  });

  test("a synced package is clean and pinned", async () => {
    await configure();
    expect((await cli(["sync"])).exitCode).toBe(0);
    const pkg = await onlyPackage();
    expect(pkg).toMatchObject({
      commit: fx.c2,
      condition: "clean",
      lockedRef: "main",
      nextActions: [],
      patches: { count: 0, format: "none", overlayFiles: [], series: [] },
      update: null,
    });
    expect(pkg.checkout).toEqual({
      changedFiles: [],
      commit: fx.c2,
      patchesChangedSinceSync: false,
      path: "inrepo_modules/upstream",
      present: true,
      tracked: true,
      uncapturedEdits: false,
    });

    const human = await cli(["status"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(`upstream  @ ${fx.c2.slice(0, 7)} (main)`);
    expect(human.stdout).toContain("state: clean");
  });

  test("edits in the checkout are reported with the files and the capture command, without writing", async () => {
    await configure();
    expect((await cli(["sync"])).exitCode).toBe(0);
    await writeFile(
      nodePath.join(moduleDir, "src", "index.ts"),
      "export const v = 42;\n",
      "utf-8"
    );
    await writeFile(
      nodePath.join(moduleDir, "src", "extra.ts"),
      "export const extra = 1;\n",
      "utf-8"
    );

    const before = await snapshotTree(cwd);
    const pkg = await onlyPackage();
    expect(pkg.condition).toBe("uncaptured-edits");
    expect(pkg.checkout).toMatchObject({
      changedFiles: ["src/extra.ts", "src/index.ts"],
      uncapturedEdits: true,
    });
    expect(pkg.nextActions).toEqual([
      'inrepo patch upstream -m "<reason>"',
      "inrepo sync --force",
    ]);

    const human = await cli(["status", "upstream"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("state: uncaptured edits");
    expect(human.stdout).toContain("src/index.ts");
    expect(human.stdout).toContain('next: inrepo patch upstream -m "<reason>"');
    expect(await snapshotTree(cwd)).toEqual(before);

    // Capturing the edit turns it into a numbered patch and the package is clean.
    expect(
      (await cli(["patch", "upstream", "-m", "Local tweaks"])).exitCode
    ).toBe(0);
    const captured = await onlyPackage();
    expect(captured.condition).toBe("clean");
    expect(captured.patches).toEqual({
      count: 1,
      format: "series",
      overlayFiles: [],
      series: [
        {
          fileName: "0001-Local-tweaks.patch",
          number: 1,
          subject: "Local tweaks",
        },
      ],
    });
  });

  test("a missing checkout or moved patches ask for a sync", async () => {
    await configure();
    expect((await cli(["sync"])).exitCode).toBe(0);
    await writeFile(
      nodePath.join(moduleDir, "README.md"),
      "# patched\n",
      "utf-8"
    );
    expect((await cli(["patch", "upstream", "-m", "Readme"])).exitCode).toBe(0);

    // Someone dropped the committed patch (e.g. a branch switch): rebuild.
    await rm(nodePath.join(cwd, "inrepo_patches"), {
      force: true,
      recursive: true,
    });
    const stale = await onlyPackage();
    expect(stale.condition).toBe("needs-sync");
    expect(stale.checkout).toMatchObject({
      patchesChangedSinceSync: true,
      uncapturedEdits: false,
    });
    expect(stale.nextActions).toEqual(["inrepo sync"]);

    await rm(moduleDir, { force: true, recursive: true });
    const missing = await onlyPackage();
    expect(missing.condition).toBe("missing");
    expect(missing.nextActions).toEqual(["inrepo sync"]);
  });

  test("a stopped update reports the patch, the conflicted files, and how to finish", async () => {
    await configure();
    expect((await cli(["sync"])).exitCode).toBe(0);
    await writeFile(
      nodePath.join(moduleDir, "src", "index.ts"),
      "export const v = 42;\n",
      "utf-8"
    );
    expect(
      (await cli(["patch", "upstream", "-m", "Bump the exported version"]))
        .exitCode
    ).toBe(0);
    const moved = await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);

    const before = await snapshotTree(cwd);
    const data = await statusJson();
    expect(data.nextActions).toEqual([
      "inrepo update upstream --continue",
      "inrepo update upstream --abort",
    ]);
    // SAFETY: status data always carries a packages array.
    const [pkg] = data.packages as JsonObject[];
    expect(pkg.condition).toBe("update-in-progress");
    expect(pkg.commit).toBe(fx.c2);
    expect(pkg.update).toMatchObject({
      conflictedFiles: ["src/index.ts"],
      fromCommit: fx.c2,
      inProgress: true,
      readyToContinue: false,
      rebaseStopped: true,
      repoPath: ".inrepo/updates/upstream/repo",
      stoppedAt: { number: 1, subject: "Bump the exported version" },
      targetCommit: moved,
      targetRef: "main",
      unresolvedFiles: ["src/index.ts"],
    });

    const human = await cli(["status"]);
    expect(human.stdout).toContain(
      'stopped on patch 0001 "Bump the exported version"'
    );
    expect(human.stdout).toContain("unresolved conflicts:");
    expect(human.stdout).toContain("next: inrepo update upstream --continue");
    expect(await snapshotTree(cwd)).toEqual(before);

    // Once the markers are gone, status says the update can continue.
    await writeFile(
      nodePath.join(updateRepo, "src", "index.ts"),
      "export const v = 3 + 42;\n",
      "utf-8"
    );
    const resolved = await onlyPackage();
    // SAFETY: an update is in progress, so `update` is an object.
    const update = resolved.update as { [key: string]: JsonValue };
    expect(update.unresolvedFiles).toEqual([]);
    expect(update.readyToContinue).toBe(true);
  });

  test("lockfile-only packages are listed when there is no config entry", async () => {
    await configure();
    expect((await cli(["sync"])).exitCode).toBe(0);
    await writeConfig(cwd, MODE, { packages: [] });
    const data = await statusJson();
    expect(data.lockfilePath).toBe("inrepo.lock.json");
    // SAFETY: status data always carries a packages array.
    const [pkg] = data.packages as JsonObject[];
    expect(pkg).toMatchObject({
      commit: fx.c2,
      condition: "clean",
      configured: false,
      name: "upstream",
    });
  });

  test("rejects unknown packages and bad arguments with typed errors", async () => {
    await configure();
    const unknown = await cli(["status", "nope", "--json"]);
    expect(unknown.exitCode).toBe(2);
    const env = envelope(unknown);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("PACKAGE_NOT_FOUND");
    expect(env.error?.details).toEqual({
      known: ["upstream"],
      package: "nope",
    });

    const option = await cli(["status", "--bogus", "--json"]);
    expect(option.exitCode).toBe(2);
    expect(envelope(option).error?.code).toBe("USAGE");

    const extra = await cli(["status", "a", "b"]);
    expect(extra.exitCode).toBe(1);
    expect(extra.stderr).toContain("status takes at most one package <name>");

    const dryRun = await cli(["status", "--dry-run", "--json"]);
    expect(dryRun.exitCode).toBe(2);
    expect(envelope(dryRun).error?.code).toBe("USAGE");
  });
});
