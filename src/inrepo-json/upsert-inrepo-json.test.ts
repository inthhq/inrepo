import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { defaultInrepoJsonSchemaRef } from "./default-inrepo-json-schema-ref.js";
import { upsertInrepoJson } from "./upsert-inrepo-json.js";

const readJson = async function readJson(path: string): Promise<JsonObject> {
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return JSON.parse(await readFile(path, "utf-8")) as JsonObject;
};

describe("upsertInrepoJson", () => {
  let cwd: string;
  let path: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-upsert-");
    path = nodePath.join(cwd, "inrepo.json");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("creates inrepo.json with default $schema when missing", async () => {
    await upsertInrepoJson(cwd, {
      git: "https://example.com/a.git",
      name: "a",
      ref: "main",
    });
    expect(existsSync(path)).toBe(true);
    const data = await readJson(path);
    expect(data.packages).toEqual([
      { git: "https://example.com/a.git", name: "a", ref: "main" },
    ]);
    expect(data.$schema).toBe(defaultInrepoJsonSchemaRef);
  });

  test("appends to bare-array config and promotes it to an object root with default $schema", async () => {
    await writeFile(path, `${JSON.stringify([{ name: "a" }])}\n`, "utf-8");
    await upsertInrepoJson(cwd, { name: "b" });
    const data = await readJson(path);
    expect(data.packages).toEqual([{ name: "a" }, { name: "b" }]);
    expect(data.$schema).toBe(defaultInrepoJsonSchemaRef);
  });

  test("updates existing entry by name and merges git/ref", async () => {
    await upsertInrepoJson(cwd, {
      git: "https://example.com/a.git",
      name: "a",
    });
    await upsertInrepoJson(cwd, { name: "a", ref: "v1.2.3" });
    const data = await readJson(path);
    expect(data.packages).toEqual([
      { git: "https://example.com/a.git", name: "a", ref: "v1.2.3" },
    ]);
  });

  test("keeps distinct version-qualified modules for the same source package", async () => {
    await upsertInrepoJson(cwd, {
      module: "shared@1.0.0",
      name: "shared",
      ref: "v1.0.0",
    });
    await upsertInrepoJson(cwd, {
      module: "shared@2.0.0",
      name: "shared",
      ref: "v2.0.0",
    });
    await upsertInrepoJson(cwd, {
      git: "https://x/shared.git",
      module: "shared@1.0.0",
      name: "shared",
    });
    expect((await readJson(path)).packages).toEqual([
      {
        git: "https://x/shared.git",
        module: "shared@1.0.0",
        name: "shared",
        ref: "v1.0.0",
      },
      { module: "shared@2.0.0", name: "shared", ref: "v2.0.0" },
    ]);
  });

  test("toggles dev: true on, then off when omitted", async () => {
    await upsertInrepoJson(cwd, { dev: true, name: "a" });
    expect((await readJson(path)).packages).toEqual([{ dev: true, name: "a" }]);
    await upsertInrepoJson(cwd, { name: "a" });
    expect((await readJson(path)).packages).toEqual([{ name: "a" }]);
  });

  test("records, preserves, and explicitly clears repositoryDirectory", async () => {
    await upsertInrepoJson(cwd, {
      name: "@scope/cli",
      repositoryDirectory: "./packages/cli/",
    });
    expect((await readJson(path)).packages).toEqual([
      { name: "@scope/cli", repositoryDirectory: "packages/cli" },
    ]);

    await upsertInrepoJson(cwd, { name: "@scope/cli", ref: "v1" });
    expect((await readJson(path)).packages).toEqual([
      { name: "@scope/cli", ref: "v1", repositoryDirectory: "packages/cli" },
    ]);

    await upsertInrepoJson(cwd, {
      name: "@scope/cli",
      repositoryDirectory: null,
    });
    expect((await readJson(path)).packages).toEqual([
      { name: "@scope/cli", ref: "v1" },
    ]);
  });

  test("preserves existing $schema and other top-level keys / order", async () => {
    const original = {
      $schema: "https://example.com/custom.schema.json",
      exclude: [".git"],
      keep: ["src"],
      packages: [{ name: "a" }],
      somethingCustom: { hello: "world" },
    };
    await writeFile(path, `${JSON.stringify(original, null, 2)}\n`, "utf-8");
    await upsertInrepoJson(cwd, { dev: true, name: "b" });

    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual([
      "$schema",
      "exclude",
      "keep",
      "packages",
      "somethingCustom",
    ]);
    expect(parsed.$schema).toBe("https://example.com/custom.schema.json");
    expect(parsed.exclude).toEqual([".git"]);
    expect(parsed.keep).toEqual(["src"]);
    expect(parsed.somethingCustom).toEqual({ hello: "world" });
    expect(parsed.packages).toEqual([{ name: "a" }, { dev: true, name: "b" }]);
  });

  test("throws on invalid existing JSON", async () => {
    await writeFile(path, "{ broken", "utf-8");
    await expect(upsertInrepoJson(cwd, { name: "a" })).rejects.toThrow(
      /Invalid JSON in inrepo\.json/u
    );
  });

  test("throws on invalid root shape", async () => {
    await writeFile(path, JSON.stringify("nope"), "utf-8");
    await expect(upsertInrepoJson(cwd, { name: "a" })).rejects.toThrow(
      /must be a JSON array or \{ "packages": \[\.\.\.\] \}/u
    );
  });
});
