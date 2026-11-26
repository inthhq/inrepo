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
            git: " https://example.com/o/r.git ",
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
});
