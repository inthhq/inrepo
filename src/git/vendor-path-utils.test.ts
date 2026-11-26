import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { assertSafeUnderDest } from "./vendor-path-utils.js";

describe("assertSafeUnderDest", () => {
  const root = nodePath.resolve(tmpdir(), "inrepo-safe-root");

  test("returns absolute path for normal relative entry", () => {
    expect(assertSafeUnderDest(root, "a/b")).toBe(
      nodePath.join(root, "a", "b")
    );
  });

  test("rejects empty (resolves to root itself)", () => {
    expect(() => assertSafeUnderDest(root, "")).toThrow(
      /Refusing to use the entire vendor directory/u
    );
  });

  test('rejects ".." escape', () => {
    expect(() => assertSafeUnderDest(root, "../escape")).toThrow(
      /Unsafe path/u
    );
    expect(() => assertSafeUnderDest(root, "a/../../b")).toThrow(
      /Unsafe path/u
    );
  });
});
