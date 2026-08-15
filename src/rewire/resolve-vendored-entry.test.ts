import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import {
  loadEntryManifest,
  resolveVendoredEntry,
} from "./resolve-vendored-entry.js";

describe("resolveVendoredEntry", () => {
  let dep: string;

  beforeEach(async () => {
    dep = await makeTmpDir("inrepo-entry-");
  });

  afterEach(async () => {
    await cleanupTmpDir(dep);
  });

  const writeFiles = async function writeFiles(
    manifest: JsonObject,
    files: Record<string, string>
  ): Promise<void> {
    await writeFile(
      nodePath.join(dep, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8"
    );
    for (const [path, contents] of Object.entries(files)) {
      const abs = nodePath.join(dep, ...path.split("/"));
      await mkdir(nodePath.dirname(abs), { recursive: true });
      await writeFile(abs, contents, "utf-8");
    }
  };

  const resolve = function resolve(
    subpath: string,
    condition: "import" | "require" = "import"
  ) {
    return loadEntryManifest(dep).then((manifest) =>
      resolveVendoredEntry({ condition, depRoot: dep, manifest, subpath })
    );
  };

  test('resolves "main" to a concrete file', async () => {
    await writeFiles({ main: "lib/dep.js", name: "dep" }, { "lib/dep.js": "" });
    expect(await resolve("")).toBe("lib/dep.js");
  });

  test('prefers "module" over "main" for an import and "main" for a require', async () => {
    await writeFiles(
      { main: "dist/cjs.js", module: "dist/esm.js", name: "dep" },
      { "dist/cjs.js": "", "dist/esm.js": "" }
    );
    expect(await resolve("", "import")).toBe("dist/esm.js");
    expect(await resolve("", "require")).toBe("dist/cjs.js");
  });

  test('honors an "exports" string and a conditions object', async () => {
    await writeFiles(
      { exports: "./out/main.js", name: "dep" },
      { "out/main.js": "" }
    );
    expect(await resolve("")).toBe("out/main.js");

    await writeFiles(
      {
        exports: {
          ".": { import: "./esm/index.js", require: "./cjs/index.cjs" },
        },
        main: "legacy.js",
        name: "dep",
      },
      { "cjs/index.cjs": "", "esm/index.js": "", "legacy.js": "" }
    );
    expect(await resolve("", "import")).toBe("esm/index.js");
    expect(await resolve("", "require")).toBe("cjs/index.cjs");
  });

  test("prefers default over browser and node over default for an import", async () => {
    await writeFiles(
      {
        exports: { browser: "./browser.js", default: "./default.js" },
        name: "dep",
      },
      { "browser.js": "", "default.js": "" }
    );
    expect(await resolve("", "import")).toBe("default.js");

    await writeFiles(
      { exports: { default: "./default.js", node: "./node.js" }, name: "dep" },
      { "default.js": "", "node.js": "" }
    );
    expect(await resolve("", "import")).toBe("node.js");

    await writeFiles(
      {
        exports: {
          default: "./default.js",
          import: "./esm.js",
          node: "./node.js",
        },
        name: "dep",
      },
      { "default.js": "", "esm.js": "", "node.js": "" }
    );
    expect(await resolve("", "import")).toBe("esm.js");
  });

  test("prefers the Node export over a browser export for CLI source", async () => {
    await writeFiles(
      {
        exports: {
          ".": {
            browser: { import: "./dist/browser.mjs" },
            node: { import: "./dist/node.mjs" },
          },
        },
        name: "dep",
      },
      { "dist/browser.mjs": "", "dist/node.mjs": "" }
    );
    expect(await resolve("", "import")).toBe("dist/node.mjs");
  });

  test("honors an exported subpath before the literal path", async () => {
    await writeFiles(
      {
        exports: { ".": "./index.js", "./sub": "./src/sub-impl.js" },
        name: "dep",
      },
      { "index.js": "", "src/sub-impl.js": "", "sub.js": "" }
    );
    expect(await resolve("sub")).toBe("src/sub-impl.js");
  });

  test("does not resolve a subpath omitted from the exports map", async () => {
    await writeFiles(
      {
        exports: { ".": "./index.js", "./public": "./public.js" },
        name: "dep",
      },
      { "index.js": "", "public.js": "", "secret.js": "", "src/secret.js": "" }
    );
    expect(await resolve("secret")).toBeNull();
    expect(await resolve("public")).toBe("public.js");
  });

  test("adds an extension and falls back to a directory index", async () => {
    await writeFiles(
      { main: "index.js", name: "dep" },
      { "deep/index.js": "", "index.js": "" }
    );
    expect(await resolve("deep")).toBe("deep/index.js");

    await writeFiles(
      { main: "index.js", name: "dep" },
      { "index.js": "", "util.js": "" }
    );
    expect(await resolve("util")).toBe("util.js");
    expect(await resolve("util.js")).toBe("util.js");
  });

  test("resolves TypeScript source when publish-only dist output is absent", async () => {
    await writeFiles(
      { exports: "./dist/index.mjs", name: "dep" },
      { "src/index.ts": "" }
    );
    expect(await resolve("")).toBe("src/index.ts");

    await writeFiles(
      {
        exports: { "./registry": { import: "./dist/registry.js" } },
        name: "dep",
      },
      { "src/registry.ts": "" }
    );
    expect(await resolve("registry")).toBe("src/registry.ts");
  });

  test("uses a conventional source field before source-directory fallbacks", async () => {
    await writeFiles(
      { main: "./dist/index.js", name: "dep", source: "./code/entry.ts" },
      { "code/entry.ts": "", "src/index.ts": "" }
    );
    expect(await resolve("")).toBe("code/entry.ts");
  });

  test("resolves wildcard exports into a TypeScript source subpath", async () => {
    await writeFiles(
      { exports: { "./*": "./dist/*.js" }, name: "dep" },
      { "src/deep/tool.ts": "" }
    );
    expect(await resolve("deep/tool")).toBe("src/deep/tool.ts");
  });

  test("falls back to index.js when no manifest field resolves", async () => {
    await writeFiles({ main: "missing.js", name: "dep" }, { "index.js": "" });
    expect(await resolve("")).toBe("index.js");
  });

  test("returns null when nothing resolves", async () => {
    await writeFiles({ main: "index.js", name: "dep" }, { "index.js": "" });
    expect(await resolve("nope/missing.js")).toBeNull();
  });

  test("refuses a candidate escaping the dependency root", async () => {
    await writeFiles({ main: "../outside.js", name: "dep" }, {});
    expect(await resolve("")).toBeNull();
    expect(await resolve("../outside.js")).toBeNull();
  });

  test("reads no manifest at all as a plain index.js package", async () => {
    await mkdir(dep, { recursive: true });
    await writeFile(nodePath.join(dep, "index.js"), "", "utf-8");
    expect(await loadEntryManifest(dep)).toBeNull();
    expect(
      await resolveVendoredEntry({
        condition: "import",
        depRoot: dep,
        manifest: null,
        subpath: "",
      })
    ).toBe("index.js");
  });
});
