import { describe, expect, test } from "bun:test";

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
});
