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
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  bootstrapHostPackageJson,
  envFor,
  readJson,
} from "../test-utils/e2e-harness.js";
import { makeMonorepoPackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import type { MonorepoPackageGraphFixture } from "../test-utils/package-graph-fixture.js";
import { runCli } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const OFFLINE_REGISTRY = "http://127.0.0.1:9";

interface MonorepoWithDepsEnv {
  INREPO_CONFIG: string;
  INREPO_NONINTERACTIVE: string;
  INREPO_REGISTRY: string;
  GIT_CONFIG_GLOBAL: string;
  GIT_CONFIG_SYSTEM: string;
  [key: string]: string | undefined;
}

describe("CLI: monorepo add --with-deps (e2e)", () => {
  let fx: MonorepoPackageGraphFixture;
  let cwd: string;
  let env: MonorepoWithDepsEnv;

  beforeAll(async () => {
    fx = await makeMonorepoPackageGraphFixture([
      {
        checkoutDependencies: { "@scope/leaf": "workspace:*" },
        directory: "packages/root",
        files: {
          "index.js": `import { leaf } from '@scope/leaf';\nconsole.log(leaf);\n`,
        },
        manifest: { type: "module" },
        name: "@scope/root",
        publishedDependencies: { "@scope/leaf": "^1.0.0" },
        version: "1.0.0",
      },
      {
        directory: "packages/leaf",
        files: { "index.js": `export const leaf = 'shared-checkout';\n` },
        manifest: { type: "module" },
        name: "@scope/leaf",
        version: "1.0.0",
      },
      {
        checkoutDependencies: { "@scope/root": "workspace:*" },
        directory: "packages/other",
        files: {
          "index.js": `import { leaf } from '@scope/root';\nconsole.log(leaf);\n`,
        },
        manifest: { type: "module" },
        name: "@scope/other",
        publishedDependencies: { "@scope/root": "^1.0.0" },
        version: "1.0.0",
      },
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-monorepo-withdeps-");
    await bootstrapHostPackageJson(cwd);
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      `${JSON.stringify({ packages: [], rewireImports: true }, null, 2)}\n`,
      "utf-8"
    );
    env = {
      ...envFor("inrepo.json"),
      GIT_CONFIG_GLOBAL: fx.gitConfigPath,
      GIT_CONFIG_SYSTEM: "/dev/null",
      INREPO_REGISTRY: fx.registryUrl,
    };
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("uses published dependencies, shares one repository commit, and replays offline", async () => {
    const add = await runCli(["add", "--with-deps", "@scope/root"], {
      cwd,
      env,
    });
    expect(add.exitCode).toBe(0);

    const config = await readJson(nodePath.join(cwd, "inrepo.json"));
    expect(config.packages).toEqual([
      {
        name: "@scope/root",
        repositoryDirectory: "packages/root",
      },
      {
        git: fx.gitUrl("@scope/leaf"),
        module: "@scope/leaf@1.0.0",
        name: "@scope/leaf",
        ref: "v1.0.0",
        repositoryDirectory: "packages/leaf",
      },
    ]);

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const lock = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      lockfileVersion: number;
      modules: Record<string, { commit: string; repositoryDirectory?: string }>;
      graph: Record<
        string,
        { dependencies?: Record<string, { range: string }> }
      >;
    };
    expect(lock.lockfileVersion).toBe(4);
    expect(lock.modules["@scope/root"]).toMatchObject({
      commit: fx.commit,
      repositoryDirectory: "packages/root",
    });
    expect(lock.modules["@scope/leaf@1.0.0"]).toMatchObject({
      commit: fx.commit,
      repositoryDirectory: "packages/leaf",
    });
    expect(
      lock.graph["@scope/root"]?.dependencies?.["@scope/leaf"]
    ).toMatchObject({
      module: "@scope/leaf@1.0.0",
      range: "^1.0.0",
      version: "1.0.0",
    });

    expect(
      await readdir(nodePath.join(cwd, ".inrepo", "repositories"))
    ).toHaveLength(1);
    const rootIndex = nodePath.join(
      cwd,
      "inrepo_modules",
      "@scope",
      "root",
      "index.js"
    );
    expect(await readFile(rootIndex, "utf-8")).toContain(
      "from '../leaf@1.0.0/index.js'"
    );
    expect(
      existsSync(
        nodePath.join(cwd, "inrepo_modules", "@scope", "root", "packages")
      )
    ).toBe(false);

    const execution = Bun.spawn(["node", rootIndex], {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await execution.exited).toBe(0);
    expect(await new Response(execution.stdout).text()).toBe(
      "shared-checkout\n"
    );

    await rm(nodePath.join(cwd, "inrepo_modules"), {
      force: true,
      recursive: true,
    });
    const offlineEnv = { ...env, INREPO_REGISTRY: OFFLINE_REGISTRY };
    expect((await runCli(["sync"], { cwd, env: offlineEnv })).exitCode).toBe(0);
    expect((await runCli(["verify"], { cwd, env: offlineEnv })).exitCode).toBe(
      0
    );
    expect(await readFile(rootIndex, "utf-8")).toContain(
      "from '../leaf@1.0.0/index.js'"
    );
  });

  test("a second overlapping add --with-deps reuses published ranges, not checkout workspace specifiers", async () => {
    const first = await runCli(["add", "--with-deps", "@scope/root"], {
      cwd,
      env,
    });
    expect(first.exitCode).toBe(0);

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const before = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string }>;
    };

    const again = await runCli(["add", "--with-deps", "@scope/root"], {
      cwd,
      env,
    });
    expect(again.exitCode).toBe(0);
    expect(again.stderr).not.toMatch(/workspace protocol/u);
    expect(again.stdout).toMatch(/already vendored/u);

    const second = await runCli(["add", "--with-deps", "@scope/other"], {
      cwd,
      env,
    });
    expect(second.exitCode).toBe(0);
    expect(second.stderr).not.toMatch(/workspace protocol/u);
    expect(second.stdout).toMatch(/already vendored/u);
    expect(second.stdout).toMatch(
      /Vendored 1 package\(s\) for "@scope\/other"; 2 already vendored/u
    );

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const lock = (await readJson(nodePath.join(cwd, "inrepo.lock.json"))) as {
      modules: Record<string, { commit: string }>;
      graph: Record<
        string,
        { dependencies?: Record<string, { range: string; module: string }> }
      >;
    };
    expect(lock.modules["@scope/root"]?.commit).toBe(
      before.modules["@scope/root"]?.commit
    );
    expect(lock.modules["@scope/leaf@1.0.0"]?.commit).toBe(
      before.modules["@scope/leaf@1.0.0"]?.commit
    );
    expect(
      lock.graph["@scope/root"]?.dependencies?.["@scope/leaf"]
    ).toMatchObject({
      module: "@scope/leaf@1.0.0",
      range: "^1.0.0",
    });
    expect(
      lock.graph["@scope/other"]?.dependencies?.["@scope/root"]
    ).toMatchObject({
      module: "@scope/root",
      range: "^1.0.0",
    });
  });

  test("plain registry add persists its discovered repository directory", async () => {
    const add = await runCli(["add", "@scope/root"], { cwd, env });
    expect(add.exitCode).toBe(0);
    const config = await readJson(nodePath.join(cwd, "inrepo.json"));
    expect(config.packages).toEqual([
      {
        name: "@scope/root",
        repositoryDirectory: "packages/root",
      },
    ]);
    expect(
      existsSync(nodePath.join(cwd, "inrepo_modules", "@scope", "leaf"))
    ).toBe(false);
  });

  test("manual git sources accept an explicit repository directory", async () => {
    const add = await runCli(
      [
        "add",
        "--git",
        fx.gitUrl("@scope/root"),
        "--repository-directory",
        "packages/root",
        "@scope/root",
      ],
      { cwd, env }
    );
    expect(add.exitCode).toBe(0);
    const config = await readJson(nodePath.join(cwd, "inrepo.json"));
    expect(config.packages).toEqual([
      {
        git: fx.gitUrl("@scope/root"),
        name: "@scope/root",
        repositoryDirectory: "packages/root",
      },
    ]);
    expect(
      await readFile(
        nodePath.join(cwd, "inrepo_modules", "@scope", "root", "package.json"),
        "utf-8"
      )
    ).toContain('"name": "@scope/root"');
  });

  test("plain add rejects a wrong or manifest-less subtree before outputs", async () => {
    for (const directory of ["packages/leaf", "packages"]) {
      const add = await runCli(
        [
          "add",
          "--git",
          fx.gitUrl("@scope/root"),
          "--repository-directory",
          directory,
          "@scope/root",
        ],
        { cwd, env }
      );
      expect(add.exitCode).toBe(1);
      expect(add.stderr).toMatch(
        directory === "packages/leaf"
          ? /declares package "@scope\/leaf"/u
          : /has no package\.json/u
      );
      expect(existsSync(nodePath.join(cwd, "inrepo_modules"))).toBe(false);
      expect(existsSync(nodePath.join(cwd, "inrepo.lock.json"))).toBe(false);
      expect(
        (await readJson(nodePath.join(cwd, "inrepo.json"))).packages
      ).toEqual([]);
    }
  });

  test("an explicit git source keeps checkout dependency semantics", async () => {
    const add = await runCli(
      [
        "add",
        "--git",
        fx.gitUrl("@scope/root"),
        "--repository-directory",
        "packages/root",
        "--with-deps",
        "@scope/root",
      ],
      { cwd, env }
    );
    expect(add.exitCode).toBe(1);
    expect(add.stderr).toMatch(/workspace protocol/u);
    expect(existsSync(nodePath.join(cwd, "inrepo_modules"))).toBe(false);
    expect(existsSync(nodePath.join(cwd, "inrepo.lock.json"))).toBe(false);
    expect(
      (await readJson(nodePath.join(cwd, "inrepo.json"))).packages
    ).toEqual([]);
  });
});
