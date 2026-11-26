import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { JsonObject } from "../json/unknown.js";
import {
  bootstrapHostPackageJson,
  envFor,
  readJson,
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
  dryRun?: boolean;
  data?: JsonObject;
  error?: {
    code: string;
    message: string;
    hint?: string;
    nextCommand?: string;
    details?: JsonObject;
  };
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

describe("CLI: update --json and --dry-run (e2e)", () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let updateDir: string;

  beforeEach(async () => {
    fx = await makeLocalGitFixture("inrepo-json-update-");
    cwd = await makeTmpDir("inrepo-json-update-e2e-");
    moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
    updateDir = nodePath.join(cwd, ".inrepo", "updates", "upstream");
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, MODE, {
      packages: [{ git: fx.url, name: "upstream", ref: "main" }],
    });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
    await fx.cleanup();
  });

  const cli = async function cli(args: string[]): Promise<RunCliResult> {
    return await runCli(args, { cwd, env: envFor(MODE) });
  };

  const lockCommit = async function lockCommit(): Promise<string> {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const lock = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string }>;
    };
    return lock.modules.upstream.commit;
  };

  /** Sync, then capture two patches: one on `src/index.ts`, one adding a file. */
  const syncAndPatch = async function syncAndPatch(): Promise<void> {
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
    await writeFile(
      nodePath.join(moduleDir, "src", "local.ts"),
      "export const local = true;\n",
      "utf-8"
    );
    expect(
      (await cli(["patch", "upstream", "-m", "Add a local helper"])).exitCode
    ).toBe(0);
  };

  const conflictUpstream = async function conflictUpstream(): Promise<string> {
    return await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
  };

  test("a conflict is a typed UPDATE_CONFLICT failure with the files to resolve", async () => {
    await syncAndPatch();
    await conflictUpstream();

    const update = await cli(["update", "upstream", "--json"]);
    expect(update.exitCode).toBe(3);
    const env = envelope(update);
    expect(env.ok).toBe(false);
    expect(env.command).toBe("update");
    expect(env.error?.code).toBe("UPDATE_CONFLICT");
    expect(env.error?.message).toContain(
      'Rebasing "upstream" stopped on patch 0001 "Bump the exported version"'
    );
    expect(env.error?.nextCommand).toBe("inrepo update upstream --continue");
    expect(env.error?.hint).toContain("--abort");
    expect(env.error?.details).toEqual({
      conflictedFiles: ["src/index.ts"],
      package: "upstream",
      patch: { number: 1, subject: "Bump the exported version" },
      repoPath: ".inrepo/updates/upstream/repo",
    });

    // A second start is refused while this one is paused.
    const second = await cli(["update", "upstream", "--json"]);
    expect(second.exitCode).toBe(3);
    expect(envelope(second).error?.code).toBe("UPDATE_IN_PROGRESS");
    expect(envelope(second).error?.nextCommand).toBe(
      "inrepo update upstream --continue"
    );

    // --continue with markers still present is the same typed conflict.
    const early = await cli(["update", "upstream", "--continue", "--json"]);
    expect(early.exitCode).toBe(3);
    const earlyEnv = envelope(early);
    expect(earlyEnv.error?.code).toBe("UPDATE_CONFLICT");
    expect(earlyEnv.error?.details).toMatchObject({
      conflictedFiles: ["src/index.ts"],
      package: "upstream",
      patch: { number: 1, subject: "Bump the exported version" },
      repoPath: ".inrepo/updates/upstream/repo",
    });
  });

  test("--continue --json reports the finished update", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const moved = await conflictUpstream();
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);
    await writeFile(
      nodePath.join(updateDir, "repo", "src", "index.ts"),
      "export const v = 3 + 42;\n",
      "utf-8"
    );

    const done = await cli(["update", "upstream", "--continue", "--json"]);
    expect(done.exitCode).toBe(0);
    const env = envelope(done);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({
      from: { commit: before, ref: "main" },
      package: "upstream",
      patches: {
        count: 2,
        rebased: 2,
        series: [
          { number: 1, subject: "Bump the exported version" },
          { number: 2, subject: "Add a local helper" },
        ],
      },
      status: "updated",
      to: { commit: moved, ref: "main" },
    });
    expect(await lockCommit()).toBe(moved);
  });

  test("--abort --json reports the discarded update", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    await conflictUpstream();
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);

    const abort = await cli(["update", "upstream", "--abort", "--json"]);
    expect(abort.exitCode).toBe(0);
    expect(envelope(abort).data).toEqual({
      package: "upstream",
      status: "aborted",
    });
    expect(existsSync(updateDir)).toBe(false);
    expect(await lockCommit()).toBe(before);

    const again = await cli(["update", "upstream", "--abort", "--json"]);
    expect(again.exitCode).toBe(2);
    expect(envelope(again).error?.code).toBe("NO_UPDATE_IN_PROGRESS");
    const cont = await cli(["update", "upstream", "--continue", "--json"]);
    expect(cont.exitCode).toBe(2);
    expect(envelope(cont).error?.code).toBe("NO_UPDATE_IN_PROGRESS");
    expect(envelope(cont).error?.nextCommand).toBe("inrepo update upstream");
  });

  test("a clean update and an up-to-date package return typed results", async () => {
    await syncAndPatch();
    const before = await lockCommit();

    const same = await cli(["update", "upstream", "--json"]);
    expect(same.exitCode).toBe(0);
    expect(envelope(same).data).toMatchObject({
      from: { commit: before, ref: "main" },
      patches: { count: 2, rebased: 0 },
      status: "up-to-date",
      to: { commit: before, ref: "main" },
    });

    const moved = await fx.commitUpstream(
      { "README.md": "# upstream v3\n" },
      "move upstream"
    );
    const update = await cli(["update", "upstream", "--json"]);
    expect(update.exitCode).toBe(0);
    expect(envelope(update).data).toMatchObject({
      from: { commit: before, ref: "main" },
      package: "upstream",
      patches: { count: 2, rebased: 2 },
      status: "updated",
      to: { commit: moved, ref: "main" },
    });
  });

  test("--dry-run reports the would-be update and writes nothing", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const moved = await conflictUpstream();
    const snapshot = await snapshotTree(cwd);

    const preview = await cli(["update", "upstream", "--dry-run", "--json"]);
    expect(preview.exitCode).toBe(0);
    const env = envelope(preview);
    expect(env.dryRun).toBe(true);
    expect(env.data).toEqual({
      from: { commit: before, ref: "main" },
      package: "upstream",
      patches: {
        count: 2,
        rebased: 2,
        series: [
          { number: 1, subject: "Bump the exported version" },
          { number: 2, subject: "Add a local helper" },
        ],
      },
      status: "would-update",
      to: { commit: moved, ref: "main" },
    });

    const human = await cli(["update", "upstream", "--dry-run"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(
      `Would update "upstream" ${before.slice(0, 7)} → ${moved.slice(0, 7)} (main)`
    );
    expect(human.stdout).toMatch(/0001 {2}Bump the exported version/u);

    expect(await snapshotTree(cwd)).toEqual(snapshot);
    expect(existsSync(updateDir)).toBe(false);
  });

  test("--dry-run on an up-to-date package says so", async () => {
    expect((await cli(["sync"])).exitCode).toBe(0);
    const preview = await cli(["update", "upstream", "--dry-run", "--json"]);
    expect(preview.exitCode).toBe(0);
    expect(envelope(preview).data).toMatchObject({
      patches: { count: 0, rebased: 0, series: [] },
      status: "up-to-date",
    });
  });

  test("refusals are typed: uncaptured edits, dry-run misuse, unknown package", async () => {
    await syncAndPatch();
    await fx.commitUpstream(
      { "README.md": "# upstream v3\n" },
      "move upstream"
    );
    await writeFile(
      nodePath.join(moduleDir, "src", "index.ts"),
      "export const v = 1000;\n",
      "utf-8"
    );

    for (const args of [
      ["update", "upstream", "--json"],
      ["update", "upstream", "--dry-run", "--json"],
    ]) {
      const refused = await cli(args);
      expect(refused.exitCode).toBe(3);
      const env = envelope(refused);
      expect(env.error?.code).toBe("UNCAPTURED_EDITS");
      expect(env.error?.nextCommand).toBe(
        'inrepo patch upstream -m "<reason>"'
      );
    }
    expect(existsSync(updateDir)).toBe(false);

    const misuse = await cli([
      "update",
      "upstream",
      "--continue",
      "--dry-run",
      "--json",
    ]);
    expect(misuse.exitCode).toBe(2);
    expect(envelope(misuse).error?.code).toBe("USAGE");

    const unknown = await cli(["update", "nope", "--json"]);
    expect(unknown.exitCode).toBe(2);
    expect(envelope(unknown).error?.code).toBe("PACKAGE_NOT_FOUND");
  });

  test("a short commit id as --ref is USAGE (exit 2) in real and dry runs", async () => {
    expect((await cli(["sync"])).exitCode).toBe(0);
    const short = fx.c1.slice(0, 8);

    const real = await cli(["update", "upstream", "--ref", short, "--json"]);
    expect(real.exitCode).toBe(2);
    expect(envelope(real).error?.code).toBe("USAGE");
    expect(envelope(real).error?.message).toMatch(/looks like a commit id/u);

    const dry = await cli([
      "update",
      "upstream",
      "--ref",
      short,
      "--dry-run",
      "--json",
    ]);
    expect(dry.exitCode).toBe(2);
    expect(envelope(dry).error?.code).toBe("USAGE");
    expect(existsSync(updateDir)).toBe(false);
  });
});
