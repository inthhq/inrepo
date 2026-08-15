import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { restoreEnv, snapshotEnv } from "../test-utils/test-env.js";
import type { EnvSnapshot } from "../test-utils/test-env.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { ensureInrepoInitialized } from "./ensure-inrepo-initialized.js";
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
  LoadConfigNotFoundError,
} from "./load-config.js";

describe("loadConfig", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-loadcfg-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("throws LoadConfigNotFoundError when nothing exists", async () => {
    let caught: unknown;
    try {
      await loadConfig(cwd);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LoadConfigNotFoundError);
    expect(isLoadConfigNotFoundError(caught)).toBe(true);
    expect(isLoadConfigNotFoundError(new Error("other"))).toBe(false);
  });

  test("throws LoadConfigNotFoundError when package.json has no inrepo field", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ name: "host" }),
      "utf-8"
    );
    let caught: unknown;
    try {
      await loadConfig(cwd);
    } catch (error) {
      caught = error;
    }
    expect(isLoadConfigNotFoundError(caught)).toBe(true);
  });

  test("reads object-shaped inrepo.json with packages, exclude, keep", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({
        exclude: [".git", "/^docs\\//"],
        keep: ["src", "package.json"],
        packages: [
          {
            dev: true,
            git: "https://example.com/a.git",
            name: "a",
            ref: "main",
          },
        ],
      }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe("inrepo.json");
    expect(cfg.packages).toEqual([
      { dev: true, git: "https://example.com/a.git", name: "a", ref: "main" },
    ]);
    expect(cfg.exclude).toEqual([".git", "/^docs\\//"]);
    expect(cfg.keep).toEqual(["src", "package.json"]);
  });

  test("accepts a bare JSON array of packages (no root exclude/keep)", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify([{ name: "a" }, { dev: false, name: "b" }]),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.packages.map((p) => p.name)).toEqual(["a", "b"]);
    expect(cfg.exclude).toEqual([]);
    expect(cfg.keep).toEqual([]);
  });

  test("rewireImports is off unless a project sets it", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "a" }] }),
      "utf-8"
    );
    expect((await loadConfig(cwd)).rewireImports).toBe(false);

    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "a" }], rewireImports: true }),
      "utf-8"
    );
    expect((await loadConfig(cwd)).rewireImports).toBe(true);
  });

  test("a package can override the project-wide rewireImports setting", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({
        packages: [
          { name: "a", rewireImports: false },
          { name: "b" },
          { name: "c", rewireImports: true },
        ],
        rewireImports: true,
      }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.packages.map((p) => p.rewireImports)).toEqual([
      false,
      undefined,
      true,
    ]);
  });

  test("rejects a non-boolean rewireImports at both levels", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "a", rewireImports: "yes" }] }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /packages\[0\]\.rewireImports must be a boolean/u
    );

    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "a" }], rewireImports: "yes" }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /"rewireImports" must be a boolean/u
    );
  });

  test("reads rewireImports from package.json#inrepo too", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({
        inrepo: { packages: [{ name: "a" }], rewireImports: true },
        name: "h",
      }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe("package.json");
    expect(cfg.rewireImports).toBe(true);
  });

  test("per-package validation errors include the index", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "a" }, { name: "" }] }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/packages\[1\]\.name/u);
  });

  test("rejects bad git/ref/dev types", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ dev: "yes", name: "a" }] }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /packages\[0\]\.dev must be a boolean/u
    );
  });

  test("loads and validates version-qualified module identities", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({
        packages: [{ module: "shared@1.0.0", name: "shared" }],
      }),
      "utf-8"
    );
    expect((await loadConfig(cwd)).packages).toEqual([
      { module: "shared@1.0.0", name: "shared" },
    ]);

    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ module: "", name: "shared" }] }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/packages\[0\]\.module/u);
  });

  test("normalizes a package repositoryDirectory", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({
        packages: [
          { name: "@scope/cli", repositoryDirectory: "./packages/cli/" },
        ],
      }),
      "utf-8"
    );
    expect((await loadConfig(cwd)).packages).toEqual([
      { name: "@scope/cli", repositoryDirectory: "packages/cli" },
    ]);
  });

  test("rejects invalid package repositoryDirectory values", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({
        packages: [{ name: "a", repositoryDirectory: "../a" }],
      }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /packages\[0\]\.repositoryDirectory.*traversal/u
    );

    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "a", repositoryDirectory: 42 }] }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /packages\[0\]\.repositoryDirectory must be a string/u
    );
  });

  test("throws on empty inrepo.json", async () => {
    await writeFile(nodePath.join(cwd, "inrepo.json"), "   \n", "utf-8");
    await expect(loadConfig(cwd)).rejects.toThrow(/inrepo\.json is empty/u);
  });

  test("throws with helpful message on malformed JSON", async () => {
    await writeFile(nodePath.join(cwd, "inrepo.json"), "{not json", "utf-8");
    await expect(loadConfig(cwd)).rejects.toThrow(
      /Invalid JSON in inrepo\.json/u
    );
  });

  test("inrepo.json wins over package.json#inrepo (XOR preference)", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [{ name: "from-inrepo" }] }),
      "utf-8"
    );
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({
        inrepo: { packages: [{ name: "from-pkg" }] },
        name: "host",
      }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe("inrepo.json");
    expect(cfg.packages.map((p) => p.name)).toEqual(["from-inrepo"]);
  });

  test("reads package.json#inrepo when inrepo.json absent", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({
        inrepo: {
          exclude: [".git"],
          keep: ["src"],
          packages: [{ name: "a" }],
        },
        name: "host",
      }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe("package.json");
    expect(cfg.packages).toEqual([{ name: "a" }]);
    expect(cfg.exclude).toEqual([".git"]);
    expect(cfg.keep).toEqual(["src"]);
  });

  test("accepts bare-array inrepo field on package.json", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ inrepo: [{ name: "a" }], name: "host" }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.packages).toEqual([{ name: "a" }]);
  });

  test("treats package.json#inrepo: {} as initialized with no packages", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ inrepo: {}, name: "host" }),
      "utf-8"
    );
    const cfg = await loadConfig(cwd);
    expect(cfg.source).toBe("package.json");
    expect(cfg.packages).toEqual([]);
    expect(cfg.exclude).toEqual([]);
    expect(cfg.keep).toEqual([]);
  });

  test("rejects object with non-array packages key", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: "oops" }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /Config "packages" must be a JSON array/u
    );
  });

  test("rejects non-object/array inrepo field with a clear message", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ inrepo: "oops", name: "host" }),
      "utf-8"
    );
    await expect(loadConfig(cwd)).rejects.toThrow(
      /JSON array or an object with a "packages" array/u
    );
  });

  test("package.json invalid JSON surfaces a clear error", async () => {
    await writeFile(nodePath.join(cwd, "package.json"), "{ not json", "utf-8");
    await expect(loadConfig(cwd)).rejects.toThrow(/Invalid package\.json/u);
  });
});

describe("loadGlobalExclude / loadGlobalKeep", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-globals-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("return [] when no config files", async () => {
    expect(await loadGlobalExclude(cwd)).toEqual([]);
    expect(await loadGlobalKeep(cwd)).toEqual([]);
  });

  test("read globals from inrepo.json without packages key", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ exclude: [".git"], keep: ["src"] }),
      "utf-8"
    );
    expect(await loadGlobalExclude(cwd)).toEqual([".git"]);
    expect(await loadGlobalKeep(cwd)).toEqual(["src"]);
  });

  test("read globals from package.json#inrepo object", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ inrepo: { exclude: ["x"], keep: ["y"] }, name: "h" }),
      "utf-8"
    );
    expect(await loadGlobalExclude(cwd)).toEqual(["x"]);
    expect(await loadGlobalKeep(cwd)).toEqual(["y"]);
  });

  test("return [] when inrepo field is array (no root globals on bare array)", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ inrepo: [{ name: "a" }], name: "h" }),
      "utf-8"
    );
    expect(await loadGlobalExclude(cwd)).toEqual([]);
    expect(await loadGlobalKeep(cwd)).toEqual([]);
  });
});

describe("ensureInrepoInitialized + loadConfig integration", () => {
  let cwd: string;
  let envSnap: EnvSnapshot;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-integration-");
    envSnap = snapshotEnv();
    process.env.INREPO_NONINTERACTIVE = "1";
    delete process.env.INREPO_CONFIG;
    delete process.env.CI;
  });

  afterEach(async () => {
    restoreEnv(envSnap);
    await cleanupTmpDir(cwd);
  });

  test("package.json#inrepo: {} flows through ensureInrepoInitialized into loadConfig with no packages", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ inrepo: {}, name: "host" })}\n`,
      "utf-8"
    );
    await ensureInrepoInitialized(cwd);
    const cfg = await loadConfig(cwd);
    expect(cfg.packages).toEqual([]);
    expect(cfg.source).toBe("package.json");
  });

  test("after init via INREPO_CONFIG=inrepo.json, loadConfig returns empty packages", async () => {
    process.env.INREPO_CONFIG = "inrepo.json";
    await ensureInrepoInitialized(cwd);
    const cfg = await loadConfig(cwd);
    expect(cfg.packages).toEqual([]);
    expect(cfg.source).toBe("inrepo.json");
  });
});
