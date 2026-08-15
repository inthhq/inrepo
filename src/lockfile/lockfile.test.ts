import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import type { JsonObject } from "../json/unknown.js";
import { lockfilePath } from "../paths/lockfile-path.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { readLockfile } from "./read-lockfile.js";
import { upsertLockGraph } from "./upsert-lock-graph.js";
import { upsertLockModule } from "./upsert-lock-module.js";
import { writeLockfile } from "./write-lockfile.js";

describe("lockfile read/write/upsert", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-lock-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("reads empty modules when file is missing", async () => {
    const lf = await readLockfile(cwd);
    expect(lf).toEqual({ graph: {}, lockfileVersion: 1, modules: {} });
  });

  test("round-trips through write/read", async () => {
    await writeLockfile(cwd, {
      foo: {
        commit: "1234567890abcdef1234567890abcdef12345678",
        gitUrl: "https://github.com/x/foo.git",
        ref: null,
        source: "foo",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const lf = await readLockfile(cwd);
    expect(Object.keys(lf.modules)).toEqual(["foo"]);
    expect(lf.modules.foo.gitUrl).toBe("https://github.com/x/foo.git");
    const onDisk = await readFile(lockfilePath(cwd), "utf-8");
    expect(onDisk.endsWith("\n")).toBe(true);
  });

  test("upsertLockModule preserves existing entries and overwrites by key", async () => {
    await upsertLockModule(cwd, "a", {
      commit: "a".repeat(40),
      gitUrl: "https://github.com/x/a.git",
      ref: null,
      source: "a",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await upsertLockModule(cwd, "b", {
      commit: "b".repeat(40),
      gitUrl: "https://github.com/x/b.git",
      ref: "main",
      source: "b",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await upsertLockModule(cwd, "a", {
      commit: "c".repeat(40),
      gitUrl: "https://github.com/x/a.git",
      ref: "v1",
      source: "a",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const lf = await readLockfile(cwd);
    expect(Object.keys(lf.modules).toSorted()).toEqual(["a", "b"]);
    expect(lf.modules.a.commit).toBe("c".repeat(40));
    expect(lf.modules.a.ref).toBe("v1");
    expect(lf.modules.b.commit).toBe("b".repeat(40));
  });

  test("rejects malformed JSON with a helpful message", async () => {
    await writeFile(lockfilePath(cwd), "{not json", "utf-8");
    await expect(readLockfile(cwd)).rejects.toThrow(
      /Invalid inrepo\.lock\.json/u
    );
  });

  test("rejects non-object lockfile root", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify(["array", "root"]),
      "utf-8"
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/must be a JSON object/u);
  });

  test("rejects unsupported lockfileVersion", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 6, modules: {} }),
      "utf-8"
    );
    await expect(readLockfile(cwd)).rejects.toThrow(
      /Unsupported lockfileVersion: 6/u
    );
  });

  test("a project without a graph keeps writing lockfileVersion 1", async () => {
    await writeLockfile(cwd, {
      foo: {
        commit: "a".repeat(40),
        gitUrl: "https://github.com/x/foo.git",
        ref: null,
        source: "foo",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const onDisk = JSON.parse(
      await readFile(lockfilePath(cwd), "utf-8")
    ) as JsonObject;
    expect(onDisk.lockfileVersion).toBe(1);
    expect("graph" in onDisk).toBe(false);
  });

  test("round-trips a published artifact and raises the lockfile to version 5", async () => {
    const artifact = {
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      tarballUrl: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    };
    await writeLockfile(cwd, {
      example: {
        artifact,
        commit: "a".repeat(40),
        gitUrl: "https://github.com/example/example.git",
        ref: "v1.0.0",
        source: "example",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    expect(
      (
        JSON.parse(await readFile(lockfilePath(cwd), "utf-8")) as {
          lockfileVersion: number;
        }
      ).lockfileVersion
    ).toBe(5);
    expect(await (await readLockfile(cwd)).modules.example.artifact).toEqual(
      artifact
    );
  });

  test("rejects malformed published artifact metadata", async () => {
    const module = {
      commit: "a".repeat(40),
      gitUrl: "https://github.com/example/example.git",
      ref: null,
      source: "example",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({
        lockfileVersion: 5,
        modules: {
          example: {
            ...module,
            artifact: { integrity: "nope", tarballUrl: "file:///tmp/x" },
          },
        },
      })
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/artifact\.tarballUrl/u);
  });

  test("round-trips a dependency graph and raises the lockfile version", async () => {
    const graph = {
      alpha: {
        dependencies: {
          beta: { module: "beta", range: "^1.0.0", version: "1.2.0" },
        },
        root: true,
        version: "1.0.0",
      },
      beta: { version: "1.2.0" },
    };
    await writeLockfile(cwd, {}, graph);
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const onDisk = JSON.parse(
      await readFile(lockfilePath(cwd), "utf-8")
    ) as JsonObject;
    expect(onDisk.lockfileVersion).toBe(2);

    const lf = await readLockfile(cwd);
    expect(lf.lockfileVersion).toBe(2);
    expect(lf.graph).toEqual(graph);
  });

  test("round-trips repositoryDirectory and raises the lockfile to version 3", async () => {
    await writeLockfile(
      cwd,
      {
        "@scope/cli": {
          commit: "a".repeat(40),
          gitUrl: "https://github.com/c15t/c15t.git",
          ref: "@scope/cli@1.0.0",
          repositoryDirectory: "./packages/cli/",
          source: "@scope/cli",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { "@scope/cli": { root: true, version: "1.0.0" } }
    );
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const onDisk = JSON.parse(await readFile(lockfilePath(cwd), "utf-8")) as {
      lockfileVersion: number;
      modules: Record<string, { repositoryDirectory?: string }>;
    };
    expect(onDisk.lockfileVersion).toBe(3);
    expect(onDisk.modules["@scope/cli"].repositoryDirectory).toBe(
      "packages/cli"
    );
    expect(
      await (
        await readLockfile(cwd)
      ).modules["@scope/cli"].repositoryDirectory
    ).toBe("packages/cli");
  });

  test("round-trips version-qualified instances and raises the lockfile to version 4", async () => {
    await writeLockfile(
      cwd,
      {
        "shared@1.0.0": {
          commit: "a".repeat(40),
          gitUrl: "https://github.com/x/shared.git",
          ref: "v1.0.0",
          source: "shared",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      { "shared@1.0.0": { version: "1.0.0" } }
    );
    const lock = await readLockfile(cwd);
    expect(lock.lockfileVersion).toBe(4);
    expect(lock.modules["shared@1.0.0"].source).toBe("shared");
    expect(lock.graph["shared@1.0.0"].version).toBe("1.0.0");
  });

  test("accepts version 3 without a graph and treats old module entries as repository-rooted", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({
        lockfileVersion: 3,
        modules: {
          root: {
            commit: "a".repeat(40),
            gitUrl: "https://github.com/x/root.git",
            ref: null,
            source: "root",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
      "utf-8"
    );
    const lock = await readLockfile(cwd);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.modules.root.repositoryDirectory).toBeUndefined();
  });

  test("rejects unsafe repositoryDirectory values while reading and writing", async () => {
    const module = {
      commit: "a".repeat(40),
      gitUrl: "https://github.com/x/workspace.git",
      ref: null,
      repositoryDirectory: "../cli",
      source: "cli",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await expect(writeLockfile(cwd, { cli: module })).rejects.toThrow(
      /traversal/u
    );

    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 3, modules: { cli: module } }),
      "utf-8"
    );
    await expect(readLockfile(cwd)).rejects.toThrow(/traversal/u);
  });

  test("upsertLockModule preserves an existing graph", async () => {
    await writeLockfile(cwd, {}, { alpha: { root: true, version: "1.0.0" } });
    await upsertLockModule(cwd, "alpha", {
      commit: "a".repeat(40),
      gitUrl: "https://github.com/x/alpha.git",
      ref: "v1.0.0",
      source: "alpha",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const lf = await readLockfile(cwd);
    expect(lf.graph).toEqual({ alpha: { root: true, version: "1.0.0" } });
    expect(lf.modules.alpha?.ref).toBe("v1.0.0");
  });

  test("upsertLockGraph merges nodes without dropping unrelated ones", async () => {
    await writeLockfile(cwd, {}, { alpha: { root: true, version: "1.0.0" } });
    await upsertLockGraph(cwd, { beta: { version: "2.0.0" } });
    const lf = await readLockfile(cwd);
    expect(Object.keys(lf.graph).toSorted()).toEqual(["alpha", "beta"]);
  });

  test("rejects a graph edge that is missing required fields", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({
        graph: { alpha: { dependencies: { beta: { version: "1.0.0" } } } },
        lockfileVersion: 2,
        modules: {},
      }),
      "utf-8"
    );
    await expect(readLockfile(cwd)).rejects.toThrow(
      /graph\["alpha"\]\.dependencies\["beta"\] needs string "range" and "module"/u
    );
  });

  test("rejects a graph that is not an object", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ graph: [], lockfileVersion: 2, modules: {} }),
      "utf-8"
    );
    await expect(readLockfile(cwd)).rejects.toThrow(
      /"graph" must be an object/u
    );
  });

  test("rejects modules that are not an object", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 1, modules: ["not", "object"] }),
      "utf-8"
    );
    await expect(readLockfile(cwd)).rejects.toThrow(
      /"modules" must be an object/u
    );
  });

  test("treats omitted modules as an empty record (does not throw)", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 1 }),
      "utf-8"
    );
    const lf = await readLockfile(cwd);
    expect(lf.modules).toEqual({});
  });

  test("upsertLockModule recovers a lockfile that has only lockfileVersion", async () => {
    await writeFile(
      lockfilePath(cwd),
      JSON.stringify({ lockfileVersion: 1 }),
      "utf-8"
    );
    await upsertLockModule(cwd, "a", {
      commit: "a".repeat(40),
      gitUrl: "https://github.com/x/a.git",
      ref: null,
      source: "a",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const lf = await readLockfile(cwd);
    expect(lf.modules.a?.commit).toBe("a".repeat(40));
  });
});
