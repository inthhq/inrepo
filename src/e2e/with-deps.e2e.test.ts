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
import { cp } from "node:fs/promises";
import nodePath from "node:path";

import { isJsonObject, isString } from "../json/unknown.js";
import {
  bootstrapHostPackageJson,
  envFor,
  readJson,
} from "../test-utils/e2e-harness.js";
import { makePackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import type { PackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import { runCli } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

interface ConfigPackage {
  name: string;
  module?: string;
  git?: string;
  ref?: string;
}

const configPackages = function configPackages(
  config: Awaited<ReturnType<typeof readJson>>
): ConfigPackage[] {
  const { packages } = config;
  if (!Array.isArray(packages)) {
    throw new TypeError("expected config.packages to be an array");
  }
  const out: ConfigPackage[] = [];
  for (const entry of packages) {
    if (!isJsonObject(entry) || !isString(entry.name)) {
      continue;
    }
    const pkg: ConfigPackage = { name: entry.name };
    if (isString(entry.module)) {
      pkg.module = entry.module;
    }
    if (isString(entry.git)) {
      pkg.git = entry.git;
    }
    if (isString(entry.ref)) {
      pkg.ref = entry.ref;
    }
    out.push(pkg);
  }
  return out;
};

interface WithDepsEnv {
  INREPO_CONFIG: string;
  INREPO_NONINTERACTIVE: string;
  INREPO_REGISTRY: string;
  [key: string]: string | undefined;
}

/** Points at a closed port: proves sync and verify never reach the registry. */
const OFFLINE_REGISTRY = "http://127.0.0.1:9";

describe("CLI: add --with-deps (e2e)", () => {
  let fx: PackageGraphFixture;
  let cwd: string;
  let env: WithDepsEnv;

  beforeAll(async () => {
    fx = await makePackageGraphFixture([
      {
        name: "alpha",
        versions: {
          "1.0.0": { dependencies: { beta: "^1.0.0", gamma: "^2.0.0" } },
        },
      },
      {
        name: "beta",
        versions: {
          "1.0.0": { dependencies: { gamma: "^2.0.0" } },
          "1.2.0": { dependencies: { gamma: "^2.0.0" } },
        },
      },
      { name: "gamma", versions: { "2.0.0": {}, "2.1.0": {} } },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-withdeps-");
    await bootstrapHostPackageJson(cwd);
    env = { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("vendors the whole runtime closure, deduping a shared dependency", async () => {
    const add = await runCli(
      ["add", "--git", fx.gitUrl("alpha"), "--with-deps", "alpha"],
      {
        cwd,
        env,
      }
    );
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain("beta ^1.0.0 → 1.2.0");
    expect(add.stdout).toContain("gamma ^2.0.0 → 2.1.0");
    expect(add.stdout).toMatch(/Vendored 3 package\(s\) for "alpha"/u);

    for (const module of ["alpha", "beta@1.2.0", "gamma@2.1.0"]) {
      expect(
        existsSync(nodePath.join(cwd, "inrepo_modules", module, "package.json"))
      ).toBe(true);
    }

    const packages = configPackages(
      await readJson(nodePath.join(cwd, "inrepo.json"))
    );
    expect(packages.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"]);
    // Dependency entries pin an exact tag so sync never needs the registry.
    expect(packages.find((p) => p.name === "beta")?.ref).toBe("v1.2.0");
    expect(packages.find((p) => p.name === "gamma")?.ref).toBe("v2.1.0");

    const lock = await readJson(nodePath.join(cwd, "inrepo.lock.json"));
    expect(lock.lockfileVersion).toBe(4);
    expect(lock.graph).toEqual({
      alpha: {
        dependencies: {
          beta: { module: "beta@1.2.0", range: "^1.0.0", version: "1.2.0" },
          gamma: { module: "gamma@2.1.0", range: "^2.0.0", version: "2.1.0" },
        },
        root: true,
        version: "1.0.0",
      },
      "beta@1.2.0": {
        dependencies: {
          gamma: { module: "gamma@2.1.0", range: "^2.0.0", version: "2.1.0" },
        },
        version: "1.2.0",
      },
      "gamma@2.1.0": { version: "2.1.0" },
    });

    const pkg = await readJson(nodePath.join(cwd, "package.json"));
    expect(pkg.dependencies).toEqual({
      alpha: "file:inrepo_modules/alpha",
    });
  });

  test("sync and verify replay a committed graph with no registry access", async () => {
    expect(
      (
        await runCli(
          ["add", "--git", fx.gitUrl("alpha"), "--with-deps", "alpha"],
          { cwd, env }
        )
      ).exitCode
    ).toBe(0);

    const offline = {
      ...envFor("inrepo.json"),
      INREPO_REGISTRY: OFFLINE_REGISTRY,
    };
    const sync = await runCli(["sync"], { cwd, env: offline });
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toMatch(/Done\. 3 package\(s\) synced/u);

    const verify = await runCli(["verify"], { cwd, env: offline });
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toMatch(/all lockfile entries match checkouts/u);
  });

  test("verify fails when the committed graph disagrees with the lockfile", async () => {
    expect(
      (
        await runCli(
          ["add", "--git", fx.gitUrl("alpha"), "--with-deps", "alpha"],
          { cwd, env }
        )
      ).exitCode
    ).toBe(0);

    const lockPath = nodePath.join(cwd, "inrepo.lock.json");
    const lock = await readJson(lockPath);
    // SAFETY: lock.graph is written by the CLI with this shape.
    const graph = lock.graph as Record<
      string,
      { dependencies?: Record<string, { range: string }> }
    >;
    const alphaDeps = graph.alpha?.dependencies?.gamma;
    expect(alphaDeps).toBeDefined();
    if (alphaDeps == null) {
      throw new Error("Expected alpha → gamma dependency in lock graph");
    }
    alphaDeps.range = "^9.0.0";
    await Bun.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const verify = await runCli(["verify"], {
      cwd,
      env: { ...envFor("inrepo.json"), INREPO_REGISTRY: OFFLINE_REGISTRY },
    });
    expect(verify.exitCode).toBe(1);
    expect(verify.stderr).toMatch(
      /depends on "gamma" \^9\.0\.0, which 2\.1\.0 does not satisfy/u
    );
  });

  test("reuses an already vendored dependency instead of re-pinning it", async () => {
    expect(
      (
        await runCli(
          ["add", "--git", fx.gitUrl("gamma"), "--ref", "v2.0.0", "gamma"],
          {
            cwd,
            env,
          }
        )
      ).exitCode
    ).toBe(0);
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const before = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string }>;
    };

    const add = await runCli(
      ["add", "--git", fx.gitUrl("alpha"), "--with-deps", "alpha"],
      {
        cwd,
        env,
      }
    );
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain("gamma ^2.0.0 → 2.0.0");
    expect(add.stdout).toContain("already vendored");
    expect(add.stdout).toMatch(
      /Vendored 2 package\(s\) for "alpha"; 1 already vendored/u
    );

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const after = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string }>;
      graph: Record<string, { version?: string }>;
    };
    expect(after.modules.gamma.commit).toBe(before.modules.gamma.commit);
    expect(after.graph.gamma.version).toBe("2.0.0");
  });

  test("completes the graph when the root is already vendored", async () => {
    expect(
      (
        await runCli(["add", "--git", fx.gitUrl("alpha"), "alpha"], {
          cwd,
          env,
        })
      ).exitCode
    ).toBe(0);
    expect(existsSync(nodePath.join(cwd, "inrepo_modules", "beta"))).toBe(
      false
    );

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const before = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string; gitUrl: string }>;
    };
    const movedTip = await fx.commitUpstream(
      "alpha",
      { "MOVED.txt": "default branch moved\n" },
      "move alpha HEAD"
    );
    expect(movedTip).not.toBe(before.modules.alpha.commit);

    const add = await runCli(["add", "--with-deps", "alpha"], { cwd, env });
    expect(add.exitCode).toBe(0);
    expect(
      existsSync(
        nodePath.join(cwd, "inrepo_modules", "beta@1.2.0", "package.json")
      )
    ).toBe(true);
    expect(
      existsSync(
        nodePath.join(cwd, "inrepo_modules", "gamma@2.1.0", "package.json")
      )
    ).toBe(true);

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const after = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string; gitUrl: string }>;
    };
    expect(after.modules.alpha.commit).toBe(before.modules.alpha.commit);
    expect(after.modules.alpha.gitUrl).toBe(before.modules.alpha.gitUrl);
    expect(after.modules.alpha.commit).not.toBe(movedTip);
  });

  test("reuses a custom git URL from the lock when --git is omitted", async () => {
    const privateDir = await makeTmpDir("inrepo-e2e-private-alpha-");
    try {
      const privateUrl = nodePath.join(privateDir, "alpha.git");
      await cp(fx.gitUrl("alpha"), privateUrl, { recursive: true });
      expect(privateUrl).not.toBe(fx.gitUrl("alpha"));

      expect(
        (await runCli(["add", "--git", privateUrl, "alpha"], { cwd, env }))
          .exitCode
      ).toBe(0);
      // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
      const before = (await readJson(
        nodePath.join(cwd, "inrepo.lock.json")
      )) as {
        modules: Record<string, { gitUrl: string; commit: string }>;
      };
      expect(before.modules.alpha.gitUrl).toBe(privateUrl);

      const add = await runCli(["add", "--with-deps", "alpha"], { cwd, env });
      expect(add.exitCode).toBe(0);
      expect(
        existsSync(
          nodePath.join(cwd, "inrepo_modules", "beta@1.2.0", "package.json")
        )
      ).toBe(true);

      // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
      const after = (await readJson(
        nodePath.join(cwd, "inrepo.lock.json")
      )) as {
        modules: Record<string, { gitUrl: string; commit: string }>;
      };
      expect(after.modules.alpha.gitUrl).toBe(before.modules.alpha.gitUrl);
      expect(after.modules.alpha.gitUrl).not.toBe(fx.gitUrl("alpha"));
      expect(after.modules.alpha.commit).toBe(before.modules.alpha.commit);
    } finally {
      await cleanupTmpDir(privateDir);
    }
  });

  test("plans an extra dependency from the patched module package.json", async () => {
    const patched = await makePackageGraphFixture([
      {
        name: "root-pkg",
        versions: { "1.0.0": { dependencies: { leaf: "^1.0.0" } } },
      },
      { name: "leaf", versions: { "1.0.0": {} } },
      { name: "extra", versions: { "1.0.0": {} } },
    ]);
    try {
      const patchedEnv = {
        ...envFor("inrepo.json"),
        INREPO_REGISTRY: patched.registryUrl,
      };
      expect(
        (
          await runCli(
            ["add", "--git", patched.gitUrl("root-pkg"), "root-pkg"],
            {
              cwd,
              env: patchedEnv,
            }
          )
        ).exitCode
      ).toBe(0);

      const manifestPath = nodePath.join(
        cwd,
        "inrepo_modules",
        "root-pkg",
        "package.json"
      );
      const manifest = await readJson(manifestPath);
      // SAFETY: package.json dependencies is a string map when present.
      const existingDeps =
        (manifest.dependencies as Record<string, string> | undefined) ?? {};
      manifest.dependencies = {
        ...existingDeps,
        extra: "^1.0.0",
      };
      await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const patch = await runCli(
        ["patch", "root-pkg", "-m", "Add extra runtime dependency"],
        {
          cwd,
          env: patchedEnv,
        }
      );
      expect(patch.exitCode).toBe(0);

      const add = await runCli(["add", "--with-deps", "root-pkg"], {
        cwd,
        env: patchedEnv,
      });
      expect(add.exitCode).toBe(0);
      expect(
        existsSync(
          nodePath.join(cwd, "inrepo_modules", "extra@1.0.0", "package.json")
        )
      ).toBe(true);
      expect(add.stdout).toContain("extra ^1.0.0 → 1.0.0");

      const lock = await readJson(nodePath.join(cwd, "inrepo.lock.json"));
      expect(lock.graph).toEqual({
        "extra@1.0.0": { version: "1.0.0" },
        "leaf@1.0.0": { version: "1.0.0" },
        "root-pkg": {
          dependencies: {
            extra: { module: "extra@1.0.0", range: "^1.0.0", version: "1.0.0" },
            leaf: { module: "leaf@1.0.0", range: "^1.0.0", version: "1.0.0" },
          },
          root: true,
          version: "1.0.0",
        },
      });
    } finally {
      await patched.cleanup();
    }
  });

  test("plain add is unchanged: one package, lockfileVersion 1, no graph", async () => {
    const add = await runCli(["add", "--git", fx.gitUrl("alpha"), "alpha"], {
      cwd,
      env,
    });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toMatch(/Recorded "alpha" in inrepo config/u);

    expect(existsSync(nodePath.join(cwd, "inrepo_modules", "beta"))).toBe(
      false
    );
    const packages = configPackages(
      await readJson(nodePath.join(cwd, "inrepo.json"))
    );
    expect(packages.map((p) => p.name)).toEqual(["alpha"]);

    const lock = await readJson(nodePath.join(cwd, "inrepo.lock.json"));
    expect(lock.lockfileVersion).toBe(1);
    expect("graph" in lock).toBe(false);
  });

  test("vendors and replays a scoped package graph", async () => {
    const scoped = await makePackageGraphFixture([
      {
        name: "@scope/root",
        versions: { "1.0.0": { dependencies: { "@scope/leaf": "^1.0.0" } } },
      },
      { name: "@scope/leaf", versions: { "1.1.0": {} } },
    ]);
    try {
      const scopedEnv = {
        ...envFor("inrepo.json"),
        INREPO_REGISTRY: scoped.registryUrl,
      };
      const add = await runCli(
        [
          "add",
          "--git",
          scoped.gitUrl("@scope/root"),
          "--with-deps",
          "@scope/root",
        ],
        { cwd, env: scopedEnv }
      );
      expect(add.exitCode).toBe(0);
      expect(
        existsSync(
          nodePath.join(cwd, "inrepo_modules", "@scope", "root", "package.json")
        )
      ).toBe(true);
      expect(
        existsSync(
          nodePath.join(
            cwd,
            "inrepo_modules",
            "@scope",
            "leaf@1.1.0",
            "package.json"
          )
        )
      ).toBe(true);

      const lock = await readJson(nodePath.join(cwd, "inrepo.lock.json"));
      expect(lock.graph).toEqual({
        "@scope/leaf@1.1.0": { version: "1.1.0" },
        "@scope/root": {
          dependencies: {
            "@scope/leaf": {
              module: "@scope/leaf@1.1.0",
              range: "^1.0.0",
              version: "1.1.0",
            },
          },
          root: true,
          version: "1.0.0",
        },
      });

      const offline = {
        ...envFor("inrepo.json"),
        INREPO_REGISTRY: OFFLINE_REGISTRY,
      };
      expect((await runCli(["sync"], { cwd, env: offline })).exitCode).toBe(0);
      expect((await runCli(["verify"], { cwd, env: offline })).exitCode).toBe(
        0
      );
    } finally {
      await scoped.cleanup();
    }
  });

  test("--with-deps cannot be combined with --no-save", async () => {
    const r = await runCli(["add", "--with-deps", "--no-save", "alpha"], {
      cwd,
      env,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--with-deps cannot be combined with --no-save/u);
  });
});

describe("CLI: add --with-deps failure modes (e2e)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-withdeps-fail-");
    await bootstrapHostPackageJson(cwd);
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const expectNothingVendored =
    async function expectNothingVendored(): Promise<void> {
      expect(existsSync(nodePath.join(cwd, "inrepo_modules"))).toBe(false);
      expect(existsSync(nodePath.join(cwd, "inrepo.lock.json"))).toBe(false);
      const cfg = await readJson(nodePath.join(cwd, "inrepo.json"));
      expect(cfg.packages).toEqual([]);
    };

  test("non-overlapping ranges materialize separate exact module instances", async () => {
    const fx = await makePackageGraphFixture([
      {
        name: "root-pkg",
        versions: {
          "1.0.0": { dependencies: { left: "^1.0.0", right: "^1.0.0" } },
        },
      },
      {
        name: "left",
        versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } } },
      },
      {
        name: "right",
        versions: { "1.0.0": { dependencies: { shared: "^2.0.0" } } },
      },
      { name: "shared", versions: { "1.0.0": {}, "2.0.0": {} } },
    ]);
    try {
      const r = await runCli(
        ["add", "--git", fx.gitUrl("root-pkg"), "--with-deps", "root-pkg"],
        {
          cwd,
          env: { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl },
        }
      );
      expect(r.exitCode).toBe(0);
      for (const module of [
        "root-pkg",
        "left@1.0.0",
        "right@1.0.0",
        "shared@1.0.0",
        "shared@2.0.0",
      ]) {
        expect(
          existsSync(
            nodePath.join(cwd, "inrepo_modules", module, "package.json")
          )
        ).toBe(true);
      }

      const packages = configPackages(
        await readJson(nodePath.join(cwd, "inrepo.json"))
      );
      expect(
        packages
          .filter((pkg) => pkg.name === "shared")
          .map((pkg) => pkg.module)
          .toSorted()
      ).toEqual(["shared@1.0.0", "shared@2.0.0"]);

      // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
      const lock = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
        lockfileVersion: number;
        modules: Record<string, { source: string }>;
        graph: Record<
          string,
          { dependencies?: Record<string, { module: string; version: string }> }
        >;
      };
      expect(lock.lockfileVersion).toBe(4);
      expect(lock.modules["shared@1.0.0"]?.source).toBe("shared");
      expect(lock.modules["shared@2.0.0"]?.source).toBe("shared");
      expect(lock.graph["left@1.0.0"]?.dependencies?.shared).toMatchObject({
        module: "shared@1.0.0",
        version: "1.0.0",
      });
      expect(lock.graph["right@1.0.0"]?.dependencies?.shared).toMatchObject({
        module: "shared@2.0.0",
        version: "2.0.0",
      });
      expect(
        (
          await runCli(["verify"], {
            cwd,
            env: {
              ...envFor("inrepo.json"),
              INREPO_REGISTRY: OFFLINE_REGISTRY,
            },
          })
        ).exitCode
      ).toBe(0);
    } finally {
      await fx.cleanup();
    }
  });

  test("an unsupported dependency source fails before anything is vendored", async () => {
    const fx = await makePackageGraphFixture([
      {
        name: "root-pkg",
        versions: {
          "1.0.0": { dependencies: { "internal-tool": "workspace:^" } },
        },
      },
    ]);
    try {
      const r = await runCli(
        ["add", "--git", fx.gitUrl("root-pkg"), "--with-deps", "root-pkg"],
        {
          cwd,
          env: { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl },
        }
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(
        /"root-pkg" depends on "internal-tool" as "workspace:\^" \(workspace protocol/u
      );
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test("a monorepo package fails instead of reading the workspace root as the package", async () => {
    const fx = await makePackageGraphFixture([
      {
        checkoutName: "workspace-root",
        name: "@scope/cli",
        versions: { "1.0.0": { dependencies: { leaf: "^1.0.0" } } },
      },
      { name: "leaf", versions: { "1.0.0": {} } },
    ]);
    try {
      const r = await runCli(
        ["add", "--git", fx.gitUrl("@scope/cli"), "--with-deps", "@scope/cli"],
        {
          cwd,
          env: { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl },
        }
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(
        'the repository root declares package "workspace-root". Monorepo package subdirectories are not supported yet.'
      );
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test("a dependency with no published tag fails with the package named", async () => {
    const fx = await makePackageGraphFixture([
      {
        name: "root-pkg",
        versions: { "1.0.0": { dependencies: { loose: "^1.0.0" } } },
      },
      { name: "loose", untagged: true, versions: { "1.0.0": {} } },
    ]);
    try {
      const r = await runCli(
        ["add", "--git", fx.gitUrl("root-pkg"), "--with-deps", "root-pkg"],
        {
          cwd,
          env: { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl },
        }
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/no tag for "loose@1\.0\.0"/u);
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test("a dependency with no repository metadata fails with the package named", async () => {
    const fx = await makePackageGraphFixture([
      {
        name: "root-pkg",
        versions: { "1.0.0": { dependencies: { hidden: "^1.0.0" } } },
      },
      { name: "hidden", noRepository: true, versions: { "1.0.0": {} } },
    ]);
    try {
      const r = await runCli(
        ["add", "--git", fx.gitUrl("root-pkg"), "--with-deps", "root-pkg"],
        {
          cwd,
          env: { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl },
        }
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(
        /"hidden@1\.0\.0".*no usable "repository" clone URL/su
      );
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });

  test("an invalid dependency subtree fails before config, graph, or modules are written", async () => {
    const fx = await makePackageGraphFixture([
      {
        name: "root-pkg",
        versions: { "1.0.0": { dependencies: { broken: "^1.0.0" } } },
      },
      {
        name: "broken",
        repositoryDirectory: "packages/missing",
        versions: { "1.0.0": {} },
      },
    ]);
    try {
      const r = await runCli(
        ["add", "--git", fx.gitUrl("root-pkg"), "--with-deps", "root-pkg"],
        {
          cwd,
          env: { ...envFor("inrepo.json"), INREPO_REGISTRY: fx.registryUrl },
        }
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(
        /Repository directory "packages\/missing" for "broken" does not exist/u
      );
      await expectNothingVendored();
    } finally {
      await fx.cleanup();
    }
  });
});
