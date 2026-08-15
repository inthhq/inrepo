import { describe, expect, test } from "bun:test";

import { validateKeepList } from "./validate-keep-list.js";

describe("validateKeepList", () => {
  test("returns [] for nullish", () => {
    expect(validateKeepList(undefined, "k")).toEqual([]);
    expect(validateKeepList(null, "k")).toEqual([]);
  });

  test("rejects non-arrays and bad entries", () => {
    expect(() => validateKeepList("foo", "k")).toThrow(
      /k must be an array of strings when set/u
    );
    expect(() => validateKeepList([""], "k")).toThrow(
      /k\[0\] must be a non-empty string/u
    );
    expect(() => validateKeepList([42], "k")).toThrow(
      /k\[0\] must be a non-empty string/u
    );
  });

  test('rejects leading slash, absolute paths, and ".." segments', () => {
    expect(() => validateKeepList(["/abs"], "k")).toThrow(
      /must be a relative path/u
    );
    expect(() => validateKeepList(["/etc/passwd"], "k")).toThrow(
      /must be a relative path/u
    );
    expect(() => validateKeepList(["a/../b"], "k")).toThrow(
      /must not contain ".."/u
    );
    expect(() => validateKeepList(["C:\\Windows"], "k")).toThrow(
      /must be relative to the module root/u
    );
  });

  test('normalizes backslashes to "/" and trims trailing "/"', () => {
    expect(validateKeepList(["src\\foo\\bar/"], "k")).toEqual(["src/foo/bar"]);
    expect(validateKeepList(["package.json", "src/"], "k")).toEqual([
      "package.json",
      "src",
    ]);
  });
});
