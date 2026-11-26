import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json/unknown.js";
import { validateMirrors } from "./validate-mirrors.js";

describe("validateMirrors", () => {
  test("absent mirrors is an empty list", () => {
    expect(validateMirrors(undefined, "mirrors")).toEqual([]);
  });

  test("fills defaults and normalizes directory", () => {
    expect(
      validateMirrors(
        [
          {
            directory: "./packages/sdk/",
            exclude: ["/\\.test\\.ts$/"],
            git: "https://example.com/o/r.git",
            name: "sdk",
          },
        ],
        "mirrors"
      )
    ).toEqual([
      {
        branch: "main",
        directory: "packages/sdk",
        exclude: ["/\\.test\\.ts$/"],
        git: "https://example.com/o/r.git",
        keep: [],
        name: "sdk",
      },
    ]);
  });

  test("a root directory is omitted", () => {
    const [mirror] = validateMirrors(
      [{ directory: ".", git: "g", name: "n" }],
      "mirrors"
    );
    expect(mirror?.directory).toBeUndefined();
  });

  test("requires name and git", () => {
    expect(() => validateMirrors([{ git: "g" }], "mirrors")).toThrow(
      /mirrors\[0\]\.name/u
    );
    expect(() => validateMirrors([{ name: "n" }], "mirrors")).toThrow(
      /mirrors\[0\]\.git/u
    );
  });

  test("rejects duplicate names, traversal, and bad patterns", () => {
    expect(() =>
      validateMirrors(
        [
          { git: "a", name: "n" },
          { git: "b", name: "n" },
        ],
        "mirrors"
      )
    ).toThrow(/more than one mirror named "n"/u);
    expect(() =>
      validateMirrors([{ directory: "../x", git: "g", name: "n" }], "mirrors")
    ).toThrow(/\.\./u);
    expect(() =>
      validateMirrors(
        [{ exclude: ["/(a+)+$/"], git: "g", name: "n" }],
        "mirrors"
      )
    ).toThrow(/ReDoS/u);
    expect(() => validateMirrors({}, "mirrors")).toThrow(/array/u);
  });

  test("rejects option-like targets and full refs as branches", () => {
    expect(() =>
      validateMirrors([{ git: "--upload-pack=x", name: "n" }], "mirrors")
    ).toThrow(/repository URL or path/u);
    expect(() =>
      validateMirrors(
        [{ branch: "refs/heads/main", git: "g", name: "n" }],
        "mirrors"
      )
    ).toThrow(/branch name/u);
  });

  test("rejects path spellings that would be silently rewritten", () => {
    const cases: JsonValue[] = [
      { directory: " sdk", git: "g", name: "n" },
      { git: "g", keep: ["src /"], name: "n" },
      { exclude: ["a/ b"], git: "g", name: "n" },
      { exclude: ["private "], git: "g", name: "n" },
      { git: "g", keep: ["src\\lib"], name: "n" },
      { exclude: ["src\\lib"], git: "g", name: "n" },
    ];
    for (const mirror of cases) {
      expect(() => validateMirrors([mirror], "mirrors")).toThrow();
    }
    expect(
      validateMirrors(
        [{ exclude: [String.raw`/\.test\.ts$/`], git: "g", name: "n" }],
        "mirrors"
      )[0]?.exclude
    ).toEqual([String.raw`/\.test\.ts$/`]);
  });

  test("rejects two mirrors publishing to the same branch", () => {
    expect(() =>
      validateMirrors(
        [
          { directory: "a", git: "g", name: "one" },
          { directory: "b", git: "./g/", name: "two" },
        ],
        "mirrors"
      )
    ).toThrow(/both publish to branch "main"/u);
  });

  test("rejects an explicitly empty keep list", () => {
    expect(() =>
      validateMirrors([{ git: "g", keep: [], name: "n" }], "mirrors")
    ).toThrow(/at least one path/u);
  });

  test("treats relative and absolute spellings of one target as duplicates", () => {
    expect(() =>
      validateMirrors(
        [
          { directory: "a", git: "../public.git", name: "one" },
          { directory: "b", git: "/work/public.git", name: "two" },
        ],
        "mirrors",
        "/work/host"
      )
    ).toThrow(/both publish/u);
  });

  test("rejects null keep, directory, exclude, and branch instead of defaulting", () => {
    expect(() =>
      validateMirrors([{ git: "g", keep: null, name: "n" }], "mirrors")
    ).toThrow(/at least one path/u);
    expect(() =>
      validateMirrors([{ directory: null, git: "g", name: "n" }], "mirrors")
    ).toThrow(/directory must be a string/u);
    expect(() =>
      validateMirrors([{ exclude: null, git: "g", name: "n" }], "mirrors")
    ).toThrow(/exclude must be an array/u);
    expect(() =>
      validateMirrors([{ branch: null, git: "g", name: "n" }], "mirrors")
    ).toThrow(/branch is required/u);
  });

  test("treats .. segments and file:// URLs to one target as duplicates", () => {
    for (const other of [
      "/work/host/../public.git",
      "file:///work/public.git",
    ]) {
      expect(() =>
        validateMirrors(
          [
            { directory: "a", git: "../public.git", name: "one" },
            { directory: "b", git: other, name: "two" },
          ],
          "mirrors",
          "/work/host"
        )
      ).toThrow(/both publish/u);
    }
  });

  test("rejects names that would break the name trailer", () => {
    for (const name of ["sdk\npublic", "a:b", "tab\tname"]) {
      expect(() => validateMirrors([{ git: "g", name }], "mirrors")).toThrow(
        /must not contain/u
      );
    }
  });

  test("rejects git and branch values with surrounding whitespace", () => {
    expect(() =>
      validateMirrors([{ git: "sdk.git ", name: "n" }], "mirrors")
    ).toThrow(/git must not start or end with whitespace/u);
    expect(() =>
      validateMirrors([{ branch: " main", git: "g", name: "n" }], "mirrors")
    ).toThrow(/branch must not start or end with whitespace/u);
  });
});
