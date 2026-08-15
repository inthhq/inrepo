import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import {
  bootstrapHostPackageJson,
  envFor,
  readConfig,
  readJson,
  writeConfig,
} from "../test-utils/e2e-harness.js";
import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import { makePackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import type { PackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import { runCli } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const MODE = "inrepo.json";

describe("CLI: update workflow (e2e)", () => {
  let fx: LocalGitFixture;
  let cwd: string;
  let moduleDir: string;
  let overlayDir: string;
  let seriesDir: string;
  let updateDir: string;

  beforeEach(async () => {
    // Each test moves upstream, so the fixture cannot be shared.
    fx = await makeLocalGitFixture("inrepo-update-");
    cwd = await makeTmpDir("inrepo-update-e2e-");
    moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
    overlayDir = nodePath.join(cwd, "inrepo_patches", "upstream");
    seriesDir = nodePath.join(overlayDir, "series");
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

  const cli = function cli(args: string[]): ReturnType<typeof runCli> {
    return runCli(args, { cwd, env: envFor(MODE) });
  };

  const lockCommit = async function lockCommit(): Promise<string> {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const lock = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string; ref: string | null }>;
    };
    return lock.modules.upstream.commit;
  };

  const lockRef = async function lockRef(): Promise<string | null> {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const lock = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { ref: string | null }>;
    };
    return lock.modules.upstream.ref;
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

  test("rebases the series onto a moved upstream and updates pin, lockfile, and module", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const moved = await fx.commitUpstream(
      { "README.md": "# upstream v3\n", "docs/new.md": "# new\n" },
      "move upstream"
    );

    const update = await cli(["update", "upstream"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(
      `Updated "upstream" ${before.slice(0, 7)} → ${moved.slice(0, 7)} (main)`
    );
    expect(update.stdout).toMatch(/0001 {2}Bump the exported version/u);
    expect(update.stdout).toMatch(/0002 {2}Add a local helper/u);
    expect(update.stdout).toContain(
      "Review the result with: inrepo diff upstream"
    );

    // The series is renumbered from 0001 and keeps its subjects.
    expect(await (await readdir(seriesDir)).toSorted()).toEqual([
      "0001-Bump-the-exported-version.patch",
      "0002-Add-a-local-helper.patch",
    ]);
    const first = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch"),
      "utf-8"
    );
    expect(first).toContain("Subject: [PATCH] Bump the exported version");

    // The pin moved and the generated module carries upstream plus the patches.
    expect(await lockCommit()).toBe(moved);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 42;\n");
    expect(
      await readFile(nodePath.join(moduleDir, "src", "local.ts"), "utf-8")
    ).toBe("export const local = true;\n");
    expect(await readFile(nodePath.join(moduleDir, "README.md"), "utf-8")).toBe(
      "# upstream v3\n"
    );
    expect(
      await readFile(nodePath.join(moduleDir, "docs", "new.md"), "utf-8")
    ).toBe("# new\n");

    expect(existsSync(updateDir)).toBe(false);
    expect((await cli(["verify"])).exitCode).toBe(0);
  });

  test("preserves patch provenance across the rebase", async () => {
    await syncAndPatch();
    const beforeHeader = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch"),
      "utf-8"
    );
    const beforeDate = /^Date: (?<g1>.+)$/mu.exec(beforeHeader)?.[1];
    const beforeFrom = /^From: (?<g1>.+)$/mu.exec(beforeHeader)?.[1];

    await fx.commitUpstream(
      { "README.md": "# upstream v3\n" },
      "move upstream"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(0);

    const afterHeader = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch"),
      "utf-8"
    );
    expect(/^Date: (?<g1>.+)$/mu.exec(afterHeader)?.[1]).toBe(beforeDate);
    expect(/^From: (?<g1>.+)$/mu.exec(afterHeader)?.[1]).toBe(beforeFrom);
  });

  test("a conflict preserves the rebase and leaves every committed file alone", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const seriesBefore = await readdir(seriesDir);
    const patchBefore = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
    );

    // Upstream rewrites the same line patch 0001 rewrote.
    await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );

    const update = await cli(["update", "upstream"]);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toContain(
      'Rebasing "upstream" stopped on patch 0001 "Bump the exported version"'
    );
    expect(update.stderr).toContain("Conflicted files:");
    expect(update.stderr).toContain("src/index.ts");
    expect(update.stderr).toContain(".inrepo/updates/upstream/repo");
    expect(update.stderr).toContain("inrepo update upstream --continue");
    expect(update.stderr).toContain("inrepo update upstream --abort");

    // The conflicted work tree is there to edit, with ordinary git markers.
    const conflicted = await readFile(
      nodePath.join(updateDir, "repo", "src", "index.ts"),
      "utf-8"
    );
    expect(conflicted).toContain("<<<<<<<");
    expect(conflicted).toContain("export const v = 3;");
    expect(conflicted).toContain("export const v = 42;");

    // Nothing that gets committed to the host repository moved.
    expect(await lockCommit()).toBe(before);
    expect(await (await readdir(seriesDir)).toSorted()).toEqual(
      seriesBefore.toSorted()
    );
    expect(
      await readFile(
        nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
      )
    ).toEqual(patchBefore);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 42;\n");
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    expect(
      ((await readConfig(cwd, MODE)).packages as { ref: string }[])[0].ref
    ).toBe("main");
  });

  test("--continue finishes the update after the conflict is resolved by hand", async () => {
    await syncAndPatch();
    const moved = await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);

    await writeFile(
      nodePath.join(updateDir, "repo", "src", "index.ts"),
      "export const v = 3 + 42;\n",
      "utf-8"
    );

    const done = await cli(["update", "upstream", "--continue"]);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain(`→ ${moved.slice(0, 7)} (main)`);

    expect(await (await readdir(seriesDir)).toSorted()).toEqual([
      "0001-Bump-the-exported-version.patch",
      "0002-Add-a-local-helper.patch",
    ]);
    expect(await lockCommit()).toBe(moved);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 3 + 42;\n");
    expect(existsSync(updateDir)).toBe(false);
    expect((await cli(["verify"])).exitCode).toBe(0);
  });

  test("--abort discards the update and leaves the project untouched", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);
    expect(existsSync(updateDir)).toBe(true);

    const abort = await cli(["update", "upstream", "--abort"]);
    expect(abort.exitCode).toBe(0);
    expect(abort.stdout).toContain(
      'Discarded the in-progress update for "upstream"'
    );

    expect(existsSync(updateDir)).toBe(false);
    expect(await lockCommit()).toBe(before);
    expect(await (await readdir(seriesDir)).toSorted()).toEqual([
      "0001-Bump-the-exported-version.patch",
      "0002-Add-a-local-helper.patch",
    ]);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 42;\n");
    expect((await cli(["verify"])).exitCode).toBe(0);
  });

  test("a failed finalize restores the series and leaves the update abortable", async () => {
    await syncAndPatch();
    const before = await lockCommit();
    const seriesBefore = await (await readdir(seriesDir)).toSorted();
    const patchBefore = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
    );

    await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);
    await writeFile(
      nodePath.join(updateDir, "repo", "src", "index.ts"),
      "export const v = 3 + 42;\n",
      "utf-8"
    );

    const lockPath = nodePath.join(cwd, "inrepo.lock.json");
    await chmod(lockPath, 0o444);

    const cont = await cli(["update", "upstream", "--continue"]);
    expect(cont.exitCode).toBe(1);
    expect(await (await readdir(seriesDir)).toSorted()).toEqual(seriesBefore);
    expect(
      await readFile(
        nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
      )
    ).toEqual(patchBefore);
    expect(existsSync(nodePath.join(updateDir, "state.json"))).toBe(true);
    expect(existsSync(nodePath.join(updateDir, "series"))).toBe(true);
    expect(await lockCommit()).toBe(before);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 42;\n");

    await chmod(lockPath, 0o644);

    const abort = await cli(["update", "upstream", "--abort"]);
    expect(abort.exitCode).toBe(0);
    expect(existsSync(updateDir)).toBe(false);
    expect(await lockCommit()).toBe(before);
    expect(await (await readdir(seriesDir)).toSorted()).toEqual(seriesBefore);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 42;\n");
  });

  test("--abort restores a series that was replaced before finalize finished", async () => {
    await syncAndPatch();
    const seriesBefore = await (await readdir(seriesDir)).toSorted();
    const patchBefore = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
    );

    await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);

    // Simulate a crash after the series swap: snapshot exists, live series is new.
    await mkdir(nodePath.join(updateDir, "series"), { recursive: true });
    for (const name of seriesBefore) {
      await writeFile(
        nodePath.join(updateDir, "series", name),
        await readFile(nodePath.join(seriesDir, name))
      );
    }
    await rm(seriesDir, { force: true, recursive: true });
    await mkdir(seriesDir, { recursive: true });
    await writeFile(
      nodePath.join(seriesDir, "0001-rebased.patch"),
      "should not survive abort\n",
      "utf-8"
    );

    const abort = await cli(["update", "upstream", "--abort"]);
    expect(abort.exitCode).toBe(0);
    expect(existsSync(updateDir)).toBe(false);
    expect(await (await readdir(seriesDir)).toSorted()).toEqual(seriesBefore);
    expect(
      await readFile(
        nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
      )
    ).toEqual(patchBefore);
  });

  test("patch and migrate are refused while an update is paused", async () => {
    await syncAndPatch();
    const seriesBefore = await (await readdir(seriesDir)).toSorted();
    const patchBefore = await readFile(
      nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
    );

    await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);

    await writeFile(
      nodePath.join(moduleDir, "src", "local.ts"),
      'export const local = "nope";\n',
      "utf-8"
    );
    const patched = await cli(["patch", "upstream", "-m", "should not land"]);
    expect(patched.exitCode).toBe(1);
    expect(patched.stderr).toContain("already in progress");
    expect(patched.stderr).toContain("inrepo update upstream --continue");
    expect(patched.stderr).toContain("inrepo update upstream --abort");
    expect(patched.stderr).toContain("before patching");

    const migrated = await cli(["migrate", "upstream"]);
    expect(migrated.exitCode).toBe(1);
    expect(migrated.stderr).toContain("already in progress");
    expect(migrated.stderr).toContain("before migrating");

    expect(await (await readdir(seriesDir)).toSorted()).toEqual(seriesBefore);
    expect(
      await readFile(
        nodePath.join(seriesDir, "0001-Bump-the-exported-version.patch")
      )
    ).toEqual(patchBefore);
  });

  test("starting a second update while one is in progress is refused", async () => {
    await syncAndPatch();
    await fx.commitUpstream(
      { "src/index.ts": "export const v = 3;\n" },
      "conflicting change"
    );
    expect((await cli(["update", "upstream"])).exitCode).toBe(1);

    const second = await cli(["update", "upstream"]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("already in progress");
    expect(second.stderr).toContain("inrepo update upstream --continue");
    expect(second.stderr).toContain("inrepo update upstream --abort");
  });

  test("--continue and --abort report when there is no update in progress", async () => {
    await syncAndPatch();

    const cont = await cli(["update", "upstream", "--continue"]);
    expect(cont.exitCode).toBe(1);
    expect(cont.stderr).toMatch(/No update in progress for "upstream"/u);

    const abort = await cli(["update", "upstream", "--abort"]);
    expect(abort.exitCode).toBe(1);
    expect(abort.stderr).toMatch(/No update in progress for "upstream"/u);
  });

  test("a package with no patches is simply re-pinned and rebuilt", async () => {
    expect((await cli(["sync"])).exitCode).toBe(0);
    const before = await lockCommit();
    const moved = await fx.commitUpstream(
      { "README.md": "# upstream v3\n" },
      "move upstream"
    );

    const update = await cli(["update", "upstream"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(
      `Updated "upstream" ${before.slice(0, 7)} → ${moved.slice(0, 7)}`
    );
    expect(await lockCommit()).toBe(moved);
    expect(await readFile(nodePath.join(moduleDir, "README.md"), "utf-8")).toBe(
      "# upstream v3\n"
    );
    expect(existsSync(seriesDir)).toBe(false);
    expect((await cli(["verify"])).exitCode).toBe(0);
  });

  test("reports that a package already at the ref tip has nothing to update", async () => {
    await syncAndPatch();
    const before = await lockCommit();

    const update = await cli(["update", "upstream"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain(
      `"upstream" is already at ${before.slice(0, 7)} (main)`
    );
    expect(await lockCommit()).toBe(before);
    expect(existsSync(updateDir)).toBe(false);
  });

  test("--ref moves the pin to another branch and records it in the config", async () => {
    await syncAndPatch();
    // Only `next` moves; `main` keeps the pinned tip.
    await fx.createBranch("next");
    const onNext = await fx.commitUpstream(
      { "README.md": "# on next\n" },
      "branch work"
    );

    const update = await cli(["update", "upstream", "--ref", "next"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("(next)");

    expect(await lockRef()).toBe("next");
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const config = (await readConfig(cwd, MODE)) as {
      packages: { name: string; ref: string }[];
    };
    expect(config.packages[0].ref).toBe("next");
    expect(await lockCommit()).toBe(onNext);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 42;\n");
    expect((await cli(["verify"])).exitCode).toBe(0);
  });

  test("refuses to update a package that still uses a legacy overlay", async () => {
    await mkdir(nodePath.join(overlayDir, "src"), { recursive: true });
    await writeFile(
      nodePath.join(overlayDir, "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );
    expect((await cli(["sync"])).exitCode).toBe(0);
    const before = await lockCommit();
    await fx.commitUpstream(
      { "README.md": "# upstream v3\n" },
      "move upstream"
    );

    const update = await cli(["update", "upstream"]);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toMatch(/still uses a legacy whole-file overlay/u);
    expect(update.stderr).toContain("inrepo migrate upstream");
    expect(await lockCommit()).toBe(before);
    expect(existsSync(updateDir)).toBe(false);

    // Migrating first makes the same update work.
    expect((await cli(["migrate", "upstream"])).exitCode).toBe(0);
    expect((await cli(["update", "upstream"])).exitCode).toBe(0);
    expect(
      await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 99;\n");
  });

  test("refuses to update over uncaptured edits in the generated module", async () => {
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

    const update = await cli(["update", "upstream"]);
    expect(update.exitCode).toBe(1);
    expect(update.stderr).toMatch(
      /uncaptured edits in "inrepo_modules\/upstream"/u
    );
    expect(existsSync(updateDir)).toBe(false);
  });

  test("argument validation", async () => {
    const missing = await cli(["update"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/update requires a package <name>/u);

    const both = await cli(["update", "upstream", "--continue", "--abort"]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toMatch(/either --continue or --abort, not both/u);

    const withRef = await cli([
      "update",
      "upstream",
      "--ref",
      "main",
      "--continue",
    ]);
    expect(withRef.exitCode).toBe(1);
    expect(withRef.stderr).toMatch(
      /--ref cannot be combined with --continue or --abort/u
    );

    const emptyRef = await cli(["update", "upstream", "--ref"]);
    expect(emptyRef.exitCode).toBe(1);
    expect(emptyRef.stderr).toMatch(/--ref requires a value/u);

    const unlocked = await cli(["update", "nope"]);
    expect(unlocked.exitCode).toBe(1);
    expect(unlocked.stderr).toMatch(
      /No configured or locked package named "nope"/u
    );
  });
});

interface UpdateGraphEnv {
  INREPO_CONFIG: string;
  INREPO_NONINTERACTIVE: string;
  INREPO_REGISTRY: string;
  [key: string]: string | undefined;
}

describe("CLI: update of a graph-tracked package (e2e)", () => {
  let fx: PackageGraphFixture;
  let cwd: string;
  let env: UpdateGraphEnv;

  beforeAll(async () => {
    fx = await makePackageGraphFixture(
      [
        {
          name: "alpha",
          versions: { "1.0.0": { dependencies: { beta: "^1.0.0" } } },
        },
        { name: "beta", versions: { "1.0.0": {}, "1.2.0": {}, "2.0.0": {} } },
      ],
      "inrepo-update-graph-fixture-"
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-update-graph-e2e-");
    await bootstrapHostPackageJson(cwd);
    env = { ...envFor(MODE), INREPO_REGISTRY: fx.registryUrl };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const cli = function cli(args: string[]): ReturnType<typeof runCli> {
    return runCli(args, { cwd, env });
  };

  const graph = async function graph(): Promise<JsonObject> {
    const lock = await readJson(nodePath.join(cwd, "inrepo.lock.json"));
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    return lock.graph as JsonObject;
  };

  /** Vendor alpha's closure with beta deliberately pinned behind its newest in-range tag. */
  const vendorGraph = async function vendorGraph(): Promise<void> {
    expect(
      (
        await cli([
          "add",
          "--git",
          fx.gitUrl("beta"),
          "--ref",
          "v1.0.0",
          "beta",
        ])
      ).exitCode
    ).toBe(0);
    const add = await cli([
      "add",
      "--git",
      fx.gitUrl("alpha"),
      "--with-deps",
      "alpha",
    ]);
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain("already vendored");
    expect(await graph()).toEqual({
      alpha: {
        dependencies: {
          beta: { module: "beta", range: "^1.0.0", version: "1.0.0" },
        },
        root: true,
        version: "1.0.0",
      },
      beta: { version: "1.0.0" },
    });
  };

  test("moves the graph with the pin, leaving verify clean", async () => {
    await vendorGraph();

    const update = await cli(["update", "beta", "--ref", "v1.2.0"]);
    expect(update.exitCode).toBe(0);
    expect(update.stderr).not.toContain("does not satisfy");

    expect(await graph()).toEqual({
      alpha: {
        dependencies: {
          beta: { module: "beta", range: "^1.0.0", version: "1.2.0" },
        },
        root: true,
        version: "1.0.0",
      },
      beta: { version: "1.2.0" },
    });

    const verify = await cli(["verify"]);
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/all lockfile entries match checkouts/u);
  });

  test("warns when the new version no longer satisfies a dependent range", async () => {
    await vendorGraph();

    const update = await cli(["update", "beta", "--ref", "v2.0.0"]);
    expect(update.exitCode).toBe(0);
    expect(update.stderr).toContain(
      '"alpha" requires "beta" ^1.0.0, which beta@2.0.0 does not satisfy'
    );
    expect(update.stderr).toContain("inrepo add --with-deps alpha");

    // The graph still records what is vendored; re-resolving the range is the
    // job of `add --with-deps`, so verify reports the requirement as broken.
    expect(await graph()).toEqual({
      alpha: {
        dependencies: {
          beta: { module: "beta", range: "^1.0.0", version: "2.0.0" },
        },
        root: true,
        version: "1.0.0",
      },
      beta: { version: "2.0.0" },
    });

    const verify = await cli(["verify"]);
    expect(verify.exitCode).toBe(1);
    expect(verify.stderr).toMatch(
      /depends on "beta" \^1\.0\.0, which 2\.0\.0 does not satisfy/u
    );
  });

  test("a package outside the graph is updated exactly as before", async () => {
    expect(
      (
        await cli([
          "add",
          "--git",
          fx.gitUrl("beta"),
          "--ref",
          "v1.0.0",
          "beta",
        ])
      ).exitCode
    ).toBe(0);
    expect(
      "graph" in (await readJson(nodePath.join(cwd, "inrepo.lock.json")))
    ).toBe(false);

    const update = await cli(["update", "beta", "--ref", "v1.2.0"]);
    expect(update.exitCode).toBe(0);
    expect(
      "graph" in (await readJson(nodePath.join(cwd, "inrepo.lock.json")))
    ).toBe(false);
    expect((await cli(["verify"])).exitCode).toBe(0);
  });
});
