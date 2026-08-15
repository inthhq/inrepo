import { describe, expect, test } from "bun:test";

import { scanModuleSpecifiers } from "./scan-module-specifiers.js";

/** Every specifier as `kind:value`, which is what the transform keys off. */
const found = function found(source: string): string[] {
  return scanModuleSpecifiers(source).map(
    (entry) => `${entry.kind}:${entry.value}`
  );
};

describe("scanModuleSpecifiers", () => {
  test("finds every static import form", () => {
    const source = [
      'import def from "a";',
      'import { named } from "b";',
      'import * as ns from "c";',
      'import "d";',
      'import def2, { other as alias } from "e";',
      "import type { T } from 'f';",
    ].join("\n");

    expect(found(source)).toEqual([
      "import:a",
      "import:b",
      "import:c",
      "import:d",
      "import:e",
      "import:f",
    ]);
  });

  test("finds re-export forms and ignores local exports", () => {
    const source = [
      'export * from "a";',
      'export * as ns from "b";',
      'export { one, two } from "c";',
      'export const from = "not-a-specifier";',
      "export default 1;",
    ].join("\n");

    expect(found(source)).toEqual(["export:a", "export:b", "export:c"]);
  });

  test("finds dynamic import and require calls, including import attributes", () => {
    const source = [
      'const a = await import("a");',
      'const b = require("b");',
      'const c = await import("c", { with: { type: "json" } });',
      'const d = require("d").sub;',
      'import(/* comment */ "e");',
    ].join("\n");

    expect(found(source)).toEqual([
      "dynamic-import:a",
      "require:b",
      "dynamic-import:c",
      "require:d",
      "dynamic-import:e",
    ]);
  });

  test("reports exact spans inside the quotes", () => {
    const source = 'import pc from "picocolors";\n';
    const [specifier] = scanModuleSpecifiers(source);

    expect(source.slice(specifier.start, specifier.end)).toBe("picocolors");
    expect(source[specifier.start - 1]).toBe('"');
    expect(source[specifier.end]).toBe('"');
  });

  test("never looks inside strings, comments, templates, or regexes", () => {
    const source = [
      '// import fake from "commented";',
      '/* require("blocked") */',
      "const text = 'import x from \"quoted\"';",
      "const other = \"require('nested')\";",
      'const tpl = `import y from "templated"`;',
      'const re = /require\\("regex"\\)/;',
      'import real from "real";',
    ].join("\n");

    expect(found(source)).toEqual(["import:real"]);
  });

  test("keeps lexing correctly through template holes and nested braces", () => {
    const source = [
      // Source under test contains template holes; built without a string `${` so the
      // lint does not treat this fixture as an accidental non-template placeholder.
      ["const tpl = `a$", "{ { k: `", "$", "{inner}` } }b$", "{ c }d`;"].join(
        ""
      ),
      "const division = total / count / 2;",
      'import real from "real";',
    ].join("\n");

    expect(found(source)).toEqual(["import:real"]);
  });

  test("leaves property calls named import or require alone", () => {
    const source = [
      'const a = obj.require("a");',
      'const b = mod.import("b");',
    ].join("\n");

    expect(found(source)).toEqual([]);
  });

  test("does not confuse import.meta with an import statement", () => {
    const source = [
      "const dir = import.meta.dirname;",
      'const rows = table.from("users");',
      'import real from "real";',
    ].join("\n");

    expect(found(source)).toEqual(["import:real"]);
  });

  test("handles subpath specifiers and single quotes", () => {
    expect(found("import x from '@scope/pkg/deep/file.js';")).toEqual([
      "import:@scope/pkg/deep/file.js",
    ]);
  });

  test("returns an empty list for a file with no specifiers", () => {
    expect(found("export const value = 1;\n")).toEqual([]);
  });
});
