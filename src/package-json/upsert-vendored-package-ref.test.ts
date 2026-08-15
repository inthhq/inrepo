import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { upsertRootPackageJsonDependency } from "./upsert-vendored-package-ref.js";

const readPkg = async function readPkg(cwd: string): Promise<JsonObject> {
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return JSON.parse(
    await readFile(nodePath.join(cwd, "package.json"), "utf-8")
  ) as JsonObject;
};

describe("upsertRootPackageJsonDependency", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-pkgdep-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("no-ops silently when package.json is missing", async () => {
    await upsertRootPackageJsonDependency(cwd, "a", false);
    expect(existsSync(nodePath.join(cwd, "package.json"))).toBe(false);
  });

  test("writes file: dependency for plain name", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ name: "host" }),
      "utf-8"
    );
    await upsertRootPackageJsonDependency(cwd, "lodash", false);
    const pkg = await readPkg(cwd);
    expect(pkg.dependencies).toEqual({ lodash: "file:inrepo_modules/lodash" });
  });

  test("writes scoped name with file: specifier under inrepo_modules/@scope/pkg", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ name: "host" }),
      "utf-8"
    );
    await upsertRootPackageJsonDependency(cwd, "@clack/prompts", true);
    const pkg = await readPkg(cwd);
    expect(pkg.devDependencies).toEqual({
      "@clack/prompts": "file:inrepo_modules/@clack/prompts",
    });
    expect(pkg.dependencies).toBeUndefined();
  });

  test("moves a name from devDependencies to dependencies and removes the empty bucket", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ devDependencies: { lodash: "1.0.0" }, name: "host" }),
      "utf-8"
    );
    await upsertRootPackageJsonDependency(cwd, "lodash", false);
    const pkg = await readPkg(cwd);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.dependencies).toEqual({ lodash: "file:inrepo_modules/lodash" });
  });

  test("strips legacy package.json#packages map when matching name is removed", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({
        name: "host",
        packages: { lodash: "inrepo_modules/lodash" },
      }),
      "utf-8"
    );
    await upsertRootPackageJsonDependency(cwd, "lodash", false);
    const pkg = await readPkg(cwd);
    expect(pkg.packages).toBeUndefined();
  });

  test("throws when dependencies bucket is invalid (array)", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ dependencies: [], name: "host" }),
      "utf-8"
    );
    await expect(
      upsertRootPackageJsonDependency(cwd, "lodash", false)
    ).rejects.toThrow(/"dependencies" must be a JSON object/u);
  });
});
