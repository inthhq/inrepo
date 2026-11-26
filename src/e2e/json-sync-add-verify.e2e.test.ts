import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vite-plus/test";

import { isJsonObject } from "../json/unknown.js";
import type { JsonObject, JsonValue } from "../json/unknown.js";
import {
  bootstrapHostPackageJson,
  envFor,
  writeConfig,
} from "../test-utils/e2e-harness.js";
import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import { makePackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import type { PackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import { runCli } from "../test-utils/run-cli.js";
import type { RunCliResult } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const ENV = envFor("inrepo.json");
/** No INREPO_CONFIG: the CLI must not be able to create a config stub. */
const NO_CONFIG_ENV = { INREPO_CONFIG: undefined, INREPO_NONINTERACTIVE: "1" };

/**
 * stdout must be exactly one JSON document. `JSON.parse` rejects anything
 * else (spinner lines, banners, a second envelope).
 */
const parseEnvelope = function parseEnvelope(r: RunCliResult): JsonObject {
  // SAFETY: JSON.parse produces a JSON value from CLI stdout.
  const parsed = JSON.parse(r.stdout) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new TypeError(`expected a JSON object on stdout, got: ${r.stdout}`);
  }
  expect(parsed.schemaVersion).toBe(1);
  return parsed;
};

const objectAt = function objectAt(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`expected an object, got: ${JSON.stringify(value)}`);
  }
  return value;
};

const arrayAt = function arrayAt(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`expected an array, got: ${JSON.stringify(value)}`);
  }
  return value;
};

/** Every file under `root` (relative path -> contents), for no-write assertions. */
const snapshotTree = async function snapshotTree(
  root: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = nodePath.join(dir, entry.name);
      const rel = nodePath.relative(root, abs);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, "");
        await walk(abs);
      } else {
        out.set(rel, await readFile(abs, "utf-8"));
      }
    }
  };
  await walk(root);
  return out;
};

describe("CLI --json / --dry-run: add, sync, verify (e2e)", () => {
  let fx: LocalGitFixture;
  let cwd: string;

  const cli = async function cli(
    args: string[],
    env: { readonly [key: string]: string | undefined } = ENV
  ): Promise<RunCliResult> {
    return await runCli(args, { cwd, env });
  };

  beforeAll(async () => {
    fx = await makeLocalGitFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-json-");
    await bootstrapHostPackageJson(cwd);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("add, sync, and verify each print one success envelope", async () => {
    const add = await cli(["add", "--json", "--git", fx.url, "upstream"]);
    expect(add.exitCode).toBe(0);
    const addEnv = parseEnvelope(add);
    expect(addEnv).toMatchObject({ command: "add", ok: true });
    const addData = objectAt(addEnv.data);
    expect(addData.saved).toBe(true);
    expect(addData.dependencies).toBeUndefined();
    expect(addData.package).toMatchObject({
      action: "created",
      backup: null,
      commit: fx.c2,
      dev: false,
      git: fx.url,
      module: "upstream",
      name: "upstream",
      patches: 0,
      path: "inrepo_modules/upstream",
      previousCommit: null,
      ref: null,
      repositoryDirectory: null,
    });
    // Human progress still happens, just on stderr.
    expect(add.stderr).toMatch(/Synced "upstream"/u);

    const sync = await cli(["sync", "--json"]);
    expect(sync.exitCode).toBe(0);
    const syncEnv = parseEnvelope(sync);
    expect(syncEnv).toMatchObject({ command: "sync", ok: true });
    const packages = arrayAt(objectAt(syncEnv.data).packages);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      action: "unchanged",
      commit: fx.c2,
      module: "upstream",
      previousCommit: fx.c2,
    });

    const verify = await cli(["verify", "--json"]);
    expect(verify.exitCode).toBe(0);
    expect(parseEnvelope(verify)).toEqual({
      command: "verify",
      data: { errors: [], issues: [], ok: true },
      ok: true,
      schemaVersion: 1,
    });
  });

  test("verify drift returns VERIFY_FAILED with structured issues and exit 1", async () => {
    expect((await cli(["add", "--git", fx.url, "upstream"])).exitCode).toBe(0);
    await writeFile(
      nodePath.join(cwd, "inrepo_modules", "upstream", "src", "index.ts"),
      "export const v = 99;\n",
      "utf-8"
    );

    const r = await cli(["verify", "--json"]);
    expect(r.exitCode).toBe(1);
    const env = parseEnvelope(r);
    expect(env.ok).toBe(false);
    expect(env.command).toBe("verify");
    expect(objectAt(env.error)).toMatchObject({
      code: "VERIFY_FAILED",
      details: { modules: ["upstream"] },
    });
    const data = objectAt(env.data);
    expect(data.ok).toBe(false);
    const issues = arrayAt(data.issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      drift: { added: [], modified: ["src/index.ts"], removed: [] },
      kind: "tree-drift",
      module: "upstream",
    });
    expect(arrayAt(data.errors)).toHaveLength(1);
  });

  test("missing config is CONFIG_NOT_FOUND with exit 2", async () => {
    const r = await cli(["sync", "--json"], NO_CONFIG_ENV);
    expect(r.exitCode).toBe(2);
    const env = parseEnvelope(r);
    expect(env).toMatchObject({
      command: "sync",
      error: { code: "CONFIG_NOT_FOUND" },
      ok: false,
    });

    const dry = await cli(["sync", "--json", "--dry-run"], NO_CONFIG_ENV);
    expect(dry.exitCode).toBe(2);
    expect(objectAt(parseEnvelope(dry).error).code).toBe("CONFIG_NOT_FOUND");
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(false);
  });

  test("malformed config and lockfile are CONFIG_INVALID / LOCKFILE_INVALID with exit 2", async () => {
    await writeConfig(cwd, "inrepo.json", { packages: [{ git: fx.url }] });
    const badConfig = await cli(["sync", "--json"]);
    expect(badConfig.exitCode).toBe(2);
    expect(objectAt(parseEnvelope(badConfig).error)).toMatchObject({
      code: "CONFIG_INVALID",
      details: { file: "inrepo.json" },
    });
    expect(objectAt(parseEnvelope(badConfig).error).message).toMatch(
      /packages\[0\]\.name is required/u
    );

    await writeConfig(cwd, "inrepo.json", { packages: [] });
    const empty = await cli(["sync", "--json"]);
    expect(empty.exitCode).toBe(2);
    expect(objectAt(parseEnvelope(empty).error).code).toBe("CONFIG_INVALID");

    await writeFile(nodePath.join(cwd, "inrepo.lock.json"), "{", "utf-8");
    const badLock = await cli(["verify", "--json"]);
    expect(badLock.exitCode).toBe(2);
    expect(objectAt(parseEnvelope(badLock).error)).toMatchObject({
      code: "LOCKFILE_INVALID",
      details: { file: "inrepo.lock.json" },
    });
  });

  test("an unreachable git remote is UPSTREAM_UNAVAILABLE with exit 4", async () => {
    await writeConfig(cwd, "inrepo.json", { packages: [] });
    const badUrl = nodePath.join(cwd, "no-such-repo.git");
    const r = await cli(["add", "--json", "--git", badUrl, "upstream"]);
    expect(r.exitCode).toBe(4);
    const error = objectAt(parseEnvelope(r).error);
    expect(error).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      details: { url: badUrl },
    });
    expect(error.message).toMatch(/git clone .* failed/u);

    const dry = await cli(["add", "--json", "--dry-run", "--git", badUrl, "x"]);
    expect(dry.exitCode).toBe(4);
    expect(objectAt(parseEnvelope(dry).error).code).toBe(
      "UPSTREAM_UNAVAILABLE"
    );
  });

  test("uncaptured edits block sync with UNCAPTURED_EDITS and exit 3", async () => {
    expect((await cli(["add", "--git", fx.url, "upstream"])).exitCode).toBe(0);
    const edited = nodePath.join(
      cwd,
      "inrepo_modules",
      "upstream",
      "src",
      "index.ts"
    );
    await writeFile(edited, "export const v = 42;\n", "utf-8");

    const r = await cli(["sync", "--json"]);
    expect(r.exitCode).toBe(3);
    const env = parseEnvelope(r);
    expect(env).toMatchObject({ command: "sync", ok: false });
    const error = objectAt(env.error);
    expect(error).toMatchObject({
      code: "UNCAPTURED_EDITS",
      details: { files: ["src/index.ts"], package: "upstream" },
      nextCommand: 'inrepo patch upstream -m "<reason>"',
    });
    expect(error.hint).toMatch(/--force/u);
    expect(error.message).toMatch(
      /uncaptured edits in "inrepo_modules\/upstream"/u
    );

    // A dry run predicts the same failure, and never touches the edit.
    const dry = await cli(["sync", "--json", "--dry-run"]);
    expect(dry.exitCode).toBe(3);
    expect(objectAt(parseEnvelope(dry).error).code).toBe("UNCAPTURED_EDITS");
    expect(await readFile(edited, "utf-8")).toBe("export const v = 42;\n");

    // Human mode keeps the message; exit classes apply only under --json.
    const human = await cli(["sync"]);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toMatch(/uncaptured edits/u);
  });

  test("add --dry-run resolves the commit but writes nothing", async () => {
    await writeConfig(cwd, "inrepo.json", { packages: [] });
    const before = await snapshotTree(cwd);

    const r = await cli([
      "add",
      "--json",
      "--dry-run",
      "--git",
      fx.url,
      "upstream",
    ]);
    expect(r.exitCode).toBe(0);
    const env = parseEnvelope(r);
    expect(env).toMatchObject({ command: "add", dryRun: true, ok: true });
    expect(objectAt(env.data)).toMatchObject({
      package: {
        action: "would-create",
        commit: fx.c2,
        git: fx.url,
        name: "upstream",
      },
      saved: true,
    });

    expect(await snapshotTree(cwd)).toEqual(before);

    const human = await cli(["add", "--dry-run", "--git", fx.url, "upstream"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toMatch(/Dry run — no files written/u);
    expect(await snapshotTree(cwd)).toEqual(before);
  });

  test("add --dry-run --ref resolves a branch tip without fetching", async () => {
    await writeConfig(cwd, "inrepo.json", { packages: [] });
    const before = await snapshotTree(cwd);
    const r = await cli([
      "add",
      "--json",
      "--dry-run",
      "--git",
      fx.url,
      "--ref",
      "main",
      "upstream",
    ]);
    expect(r.exitCode).toBe(0);
    expect(objectAt(objectAt(parseEnvelope(r).data).package)).toMatchObject({
      commit: fx.c2,
      ref: "main",
    });
    expect(await snapshotTree(cwd)).toEqual(before);
  });

  test("sync --dry-run predicts actions and writes nothing", async () => {
    await writeConfig(cwd, "inrepo.json", {
      packages: [{ git: fx.url, name: "upstream" }],
    });
    const before = await snapshotTree(cwd);

    const fresh = await cli(["sync", "--json", "--dry-run"]);
    expect(fresh.exitCode).toBe(0);
    const freshEnv = parseEnvelope(fresh);
    expect(freshEnv).toMatchObject({ dryRun: true, ok: true });
    expect(arrayAt(objectAt(freshEnv.data).packages)).toEqual([
      {
        action: "would-create",
        backup: null,
        commit: fx.c2,
        git: fx.url,
        module: "upstream",
        name: "upstream",
        patches: 0,
        path: "inrepo_modules/upstream",
        previousCommit: null,
        ref: null,
        repositoryDirectory: null,
      },
    ]);
    expect(await snapshotTree(cwd)).toEqual(before);

    const human = await cli(["sync", "--dry-run"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toMatch(/Dry run — no files written/u);
    expect(await snapshotTree(cwd)).toEqual(before);

    // After a real sync, a dry run reports the checkout as unchanged.
    expect((await cli(["sync"])).exitCode).toBe(0);
    const synced = await snapshotTree(cwd);
    const again = await cli(["sync", "--json", "--dry-run"]);
    expect(again.exitCode).toBe(0);
    expect(arrayAt(objectAt(parseEnvelope(again).data).packages)).toEqual([
      expect.objectContaining({ action: "unchanged", previousCommit: fx.c2 }),
    ]);
    expect(await snapshotTree(cwd)).toEqual(synced);
  });

  test("verify does not accept --dry-run", async () => {
    const r = await cli(["verify", "--json", "--dry-run"]);
    expect(r.exitCode).toBe(2);
    expect(objectAt(parseEnvelope(r).error).code).toBe("USAGE");
  });

  test("add --dry-run previews a short commit id --ref as given", async () => {
    await writeConfig(cwd, "inrepo.json", { packages: [] });
    const short = fx.c1.slice(0, 8);
    const dry = await cli([
      "add",
      "--json",
      "--dry-run",
      "--git",
      fx.url,
      "--ref",
      short,
      "upstream",
    ]);
    expect(dry.exitCode).toBe(0);
    expect(objectAt(objectAt(parseEnvelope(dry).data).package)).toMatchObject({
      action: "would-create",
      commit: short,
      ref: short,
    });
    expect(existsSync(nodePath.join(cwd, "inrepo.lock.json"))).toBe(false);
  });
});

describe("CLI --json / --dry-run: add --with-deps (e2e)", () => {
  let fx: PackageGraphFixture;
  let cwd: string;

  beforeAll(async () => {
    fx = await makePackageGraphFixture([
      {
        name: "alpha",
        versions: { "1.0.0": { dependencies: { beta: "^1.0.0" } } },
      },
      { name: "beta", versions: { "1.0.0": {} } },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-json-deps-");
    await bootstrapHostPackageJson(cwd);
    await writeConfig(cwd, "inrepo.json", { packages: [] });
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("reports the planned closure; a dry run writes nothing outside .inrepo/", async () => {
    const env = { ...ENV, INREPO_REGISTRY: fx.registryUrl };
    const args = ["add", "--json", "--git", fx.gitUrl("alpha"), "--with-deps"];
    const before = await snapshotTree(cwd);

    const dry = await runCli([...args, "--dry-run", "alpha"], { cwd, env });
    expect(dry.exitCode).toBe(0);
    const dryData = objectAt(parseEnvelope(dry).data);
    expect(objectAt(dryData.package)).toMatchObject({
      action: "would-create",
      name: "alpha",
    });
    expect(arrayAt(dryData.dependencies)).toEqual([
      expect.objectContaining({
        action: "would-create",
        module: "beta@1.0.0",
        name: "beta",
      }),
    ]);
    // Resolving the closure needs the root manifest, so only the cache moves.
    const after = await snapshotTree(cwd);
    for (const path of after.keys()) {
      if (!path.startsWith(".inrepo/")) {
        expect(after.get(path)).toBe(before.get(path));
      }
    }
    expect([...after.keys()].filter((p) => !p.startsWith(".inrepo"))).toEqual(
      [...before.keys()].filter((p) => !p.startsWith(".inrepo"))
    );

    const real = await runCli([...args, "alpha"], { cwd, env });
    expect(real.exitCode).toBe(0);
    expect(arrayAt(objectAt(parseEnvelope(real).data).dependencies)).toEqual([
      expect.objectContaining({ action: "created", module: "beta@1.0.0" }),
    ]);

    const again = await runCli([...args, "--dry-run", "alpha"], { cwd, env });
    expect(again.exitCode).toBe(0);
    expect(arrayAt(objectAt(parseEnvelope(again).data).dependencies)).toEqual([
      expect.objectContaining({ action: "reused", module: "beta@1.0.0" }),
    ]);
  });
});
