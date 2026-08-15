import { describe, expect, test } from "bun:test";

import { validateExcludeList } from "./validate-exclude-list.js";

describe("validateExcludeList", () => {
  test("returns [] when value is null/undefined", () => {
    expect(validateExcludeList(undefined, "x")).toEqual([]);
    expect(validateExcludeList(null, "x")).toEqual([]);
  });

  test("throws when value is not an array", () => {
    expect(() => validateExcludeList("foo", "root.exclude")).toThrow(
      /root\.exclude must be an array of strings when set/u
    );
    expect(() => validateExcludeList({}, "root.exclude")).toThrow(
      /array of strings/u
    );
  });

  test("rejects empty / non-string entries", () => {
    expect(() => validateExcludeList([""], "l")).toThrow(
      /l\[0\] must be a non-empty string/u
    );
    expect(() => validateExcludeList(["ok", 5], "l")).toThrow(
      /l\[1\] must be a non-empty string/u
    );
    expect(() => validateExcludeList(["   "], "l")).toThrow(
      /l\[0\] must be a non-empty string/u
    );
  });

  test("trims and preserves order", () => {
    expect(validateExcludeList(["  a  ", "b/c", "/re/i"], "l")).toEqual([
      "a",
      "b/c",
      "/re/i",
    ]);
  });
});
