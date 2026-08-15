import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { defaultInrepoJsonSchemaRef } from "../inrepo-json/default-inrepo-json-schema-ref.js";
import { restoreEnv, snapshotEnv } from "../test-utils/test-env.js";
import type { EnvSnapshot } from "../test-utils/test-env.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { ensureInrepoInitialized } from "./ensure-inrepo-initialized.js";

describe("ensureInrepoInitialized (non-interactive)", () => {
  let cwd: string;
  let envSnap: EnvSnapshot;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-init-");
    envSnap = snapshotEnv();
    process.env.INREPO_NONINTERACTIVE = "1";
    delete process.env.INREPO_CONFIG;
    delete process.env.CI;
  });

  afterEach(async () => {
    restoreEnv(envSnap);
    await cleanupTmpDir(cwd);
  });

  test("no-ops when inrepo.json already exists", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      '{"packages":[]}\n',
      "utf-8"
    );
    await ensureInrepoInitialized(cwd);
    const raw = await readFile(nodePath.join(cwd, "inrepo.json"), "utf-8");
    expect(raw).toBe('{"packages":[]}\n');
  });

  test("no-ops when package.json#inrepo is set", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ inrepo: { packages: [] }, name: "host" })}\n`,
      "utf-8"
    );
    await ensureInrepoInitialized(cwd);
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(false);
  });

  test("throws non-interactive hint when no config and no INREPO_CONFIG", async () => {
    await expect(ensureInrepoInitialized(cwd)).rejects.toThrow(
      /first-time setup needs an interactive terminal/u
    );
  });

  test("INREPO_CONFIG=inrepo.json writes a stub with the default $schema", async () => {
    process.env.INREPO_CONFIG = "inrepo.json";
    await ensureInrepoInitialized(cwd);
    const raw = await readFile(nodePath.join(cwd, "inrepo.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      $schema: defaultInrepoJsonSchemaRef,
      packages: [],
    });
    expect(await readFile(nodePath.join(cwd, ".gitignore"), "utf-8")).toBe(
      "/inrepo_modules/\n/.inrepo/\n"
    );
  });

  test("INREPO_CONFIG=package.json requires an existing package.json", async () => {
    process.env.INREPO_CONFIG = "package.json";
    await expect(ensureInrepoInitialized(cwd)).rejects.toThrow(
      /requires a package\.json in the project root/u
    );
  });

  test("INREPO_CONFIG=package.json adds inrepo field to existing package.json", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      `${JSON.stringify({ name: "host" })}\n`,
      "utf-8"
    );
    process.env.INREPO_CONFIG = "package.json";
    await ensureInrepoInitialized(cwd);
    const pkg = JSON.parse(
      await readFile(nodePath.join(cwd, "package.json"), "utf-8")
    );
    expect(pkg.inrepo).toEqual({ packages: [] });
    expect(pkg.name).toBe("host");
    expect(await readFile(nodePath.join(cwd, ".gitignore"), "utf-8")).toBe(
      "/inrepo_modules/\n/.inrepo/\n"
    );
  });

  test("does not duplicate root-anchored .gitignore entries", async () => {
    await writeFile(
      nodePath.join(cwd, ".gitignore"),
      "/inrepo_modules/\n/.inrepo/\n",
      "utf-8"
    );
    process.env.INREPO_CONFIG = "inrepo.json";
    await ensureInrepoInitialized(cwd);
    expect(await readFile(nodePath.join(cwd, ".gitignore"), "utf-8")).toBe(
      "/inrepo_modules/\n/.inrepo/\n"
    );
  });

  test("rejects array-valued package.json roots for package.json setup", async () => {
    await writeFile(nodePath.join(cwd, "package.json"), "[]\n", "utf-8");
    process.env.INREPO_CONFIG = "package.json";
    await expect(ensureInrepoInitialized(cwd)).rejects.toThrow(
      /Invalid package\.json: expected a JSON object at the root/u
    );
  });

  test("INREPO_CONFIG is case-insensitive", async () => {
    process.env.INREPO_CONFIG = "INREPO.JSON";
    await ensureInrepoInitialized(cwd);
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(true);
  });
});
