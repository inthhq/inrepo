import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { upsertPackageJsonInrepo } from "./upsert-package-json-inrepo.js";

const readPkg = async function readPkg(cwd: string): Promise<JsonObject> {
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return JSON.parse(
    await readFile(nodePath.join(cwd, "package.json"), "utf-8")
  ) as JsonObject;
};

describe("upsertPackageJsonInrepo", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-upsert-pkg-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("throws when package.json missing", async () => {
    await expect(upsertPackageJsonInrepo(cwd, { name: "a" })).rejects.toThrow(
      /package\.json not found/u
    );
  });

  test("throws on invalid package.json", async () => {
    await writeFile(nodePath.join(cwd, "package.json"), "{ broken", "utf-8");
    await expect(upsertPackageJsonInrepo(cwd, { name: "a" })).rejects.toThrow(
      /Invalid package\.json/u
    );
  });

  test("creates inrepo field with packages on first call, preserves other keys", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ name: "host", version: "1.0.0" }, null, 2)}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, {
      git: "https://example.com/a.git",
      name: "a",
    });
    const pkg = await readPkg(cwd);
    expect(pkg.name).toBe("host");
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.inrepo).toEqual({
      packages: [{ git: "https://example.com/a.git", name: "a" }],
    });
  });

  test("preserves root exclude/keep when present", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          inrepo: {
            exclude: [".git"],
            keep: ["src"],
            packages: [{ name: "a" }],
          },
          name: "host",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, { dev: true, name: "b" });
    const pkg = await readPkg(cwd);
    expect(pkg.inrepo).toEqual({
      exclude: [".git"],
      keep: ["src"],
      packages: [{ name: "a" }, { dev: true, name: "b" }],
    });
  });

  test("preserves root rewireImports when present", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          inrepo: { packages: [{ name: "a" }], rewireImports: true },
          name: "host",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, {
      git: "https://example.com/b.git",
      name: "b",
    });
    const pkg = await readPkg(cwd);
    expect(pkg.inrepo).toEqual({
      packages: [
        { name: "a" },
        { git: "https://example.com/b.git", name: "b" },
      ],
      rewireImports: true,
    });
  });

  test("preserves unknown extra root keys when present", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          inrepo: {
            extraFlag: true,
            packages: [{ name: "a" }],
            somethingCustom: { hello: "world" },
          },
          name: "host",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, { name: "b" });
    const pkg = await readPkg(cwd);
    expect(pkg.inrepo).toEqual({
      extraFlag: true,
      packages: [{ name: "a" }, { name: "b" }],
      somethingCustom: { hello: "world" },
    });
  });

  test("updates existing entry and toggles dev off when omitted", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({
        inrepo: { packages: [{ dev: true, name: "a" }] },
        name: "host",
      })}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, { git: "https://x/a.git", name: "a" });
    const pkg = await readPkg(cwd);
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    expect((pkg.inrepo as JsonObject).packages).toEqual([
      { git: "https://x/a.git", name: "a" },
    ]);
  });

  test("keys duplicate source packages by their module identity", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ inrepo: { packages: [] }, name: "host" })}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, {
      module: "shared@1.0.0",
      name: "shared",
      ref: "v1.0.0",
    });
    await upsertPackageJsonInrepo(cwd, {
      module: "shared@2.0.0",
      name: "shared",
      ref: "v2.0.0",
    });
    const pkg = await readPkg(cwd);
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    expect((pkg.inrepo as JsonObject).packages).toEqual([
      { module: "shared@1.0.0", name: "shared", ref: "v1.0.0" },
      { module: "shared@2.0.0", name: "shared", ref: "v2.0.0" },
    ]);
  });

  test("records, preserves, and explicitly clears repositoryDirectory", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ inrepo: { packages: [] }, name: "host" })}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, {
      name: "@scope/cli",
      repositoryDirectory: "./packages/cli/",
    });
    await upsertPackageJsonInrepo(cwd, { name: "@scope/cli", ref: "v1" });
    let pkg = await readPkg(cwd);
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    expect((pkg.inrepo as JsonObject).packages).toEqual([
      { name: "@scope/cli", ref: "v1", repositoryDirectory: "packages/cli" },
    ]);

    await upsertPackageJsonInrepo(cwd, {
      name: "@scope/cli",
      repositoryDirectory: null,
    });
    pkg = await readPkg(cwd);
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    expect((pkg.inrepo as JsonObject).packages).toEqual([
      { name: "@scope/cli", ref: "v1" },
    ]);
  });

  test("accepts a bare-array inrepo and writes back as object root", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ inrepo: [{ name: "a" }], name: "host" })}\n`,
      "utf-8"
    );
    await upsertPackageJsonInrepo(cwd, { name: "b" });
    const pkg = await readPkg(cwd);
    expect(pkg.inrepo).toEqual({ packages: [{ name: "a" }, { name: "b" }] });
  });
});
