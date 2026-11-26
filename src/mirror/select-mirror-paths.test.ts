import { describe, expect, test } from "vite-plus/test";

import { selectMirrorPaths } from "./select-mirror-paths.js";

const PATHS = [
  "README.md",
  "src/index.ts",
  "src/index.test.ts",
  "src/__tests__/helper.ts",
  "internal/notes.md",
  "packages/a/src/a.ts",
  "packages/a/tests/a.spec.ts",
];

describe("selectMirrorPaths", () => {
  test("publishes everything when keep and exclude are empty", () => {
    const { included, excluded } = selectMirrorPaths(PATHS, [], []);
    expect(included).toEqual(PATHS);
    expect(excluded).toEqual([]);
  });

  test("literal excludes drop a file or a whole directory", () => {
    const { included } = selectMirrorPaths(
      PATHS,
      [],
      ["internal/", "./README.md"]
    );
    expect(included).not.toContain("internal/notes.md");
    expect(included).not.toContain("README.md");
    expect(included).toContain("src/index.ts");
  });

  test("regex excludes match a file or any parent directory", () => {
    const { included, excluded } = selectMirrorPaths(
      PATHS,
      [],
      [String.raw`/\.(test|spec)\.ts$/`, "/(^|/)(__tests__|tests)$/"]
    );
    expect(included).toEqual([
      "README.md",
      "src/index.ts",
      "internal/notes.md",
      "packages/a/src/a.ts",
    ]);
    expect(excluded).toEqual([
      "src/index.test.ts",
      "src/__tests__/helper.ts",
      "packages/a/tests/a.spec.ts",
    ]);
  });

  test("keep runs before exclude", () => {
    const { included } = selectMirrorPaths(
      PATHS,
      ["src"],
      [String.raw`/\.test\.ts$/`]
    );
    expect(included).toEqual(["src/index.ts", "src/__tests__/helper.ts"]);
  });

  test("a literal does not match a sibling that shares its prefix", () => {
    const { included } = selectMirrorPaths(
      ["src/index.ts", "src-extra/x.ts"],
      [],
      ["src"]
    );
    expect(included).toEqual(["src-extra/x.ts"]);
  });

  test("rejects unsafe regexes", () => {
    expect(() => selectMirrorPaths(PATHS, [], ["/(a+)+$/"])).toThrow(/ReDoS/u);
  });

  test("normalizes literal spellings so excludes cannot silently miss", () => {
    const { included } = selectMirrorPaths(
      ["tests/a.ts", "internal/secret.ts", "src/index.ts"],
      ["./src", "tests/./", "internal//"],
      ["tests/./", "././internal//secret.ts"]
    );
    expect(included).toEqual(["src/index.ts"]);
  });

  test("rejects literals that escape or name the mirror root", () => {
    for (const bad of ["../x", "src/../../x", ".", "./"]) {
      expect(() => selectMirrorPaths([], [], [bad])).toThrow();
    }
    expect(() => selectMirrorPaths([], ["."], [])).toThrow(
      /inside the mirror/u
    );
  });
});
