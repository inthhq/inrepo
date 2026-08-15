import { describe, expect, test } from "bun:test";

import { normalizeRepositoryDirectory } from "./normalize-repository-directory.js";

describe("normalizeRepositoryDirectory", () => {
  test("normalizes a package subdirectory", () => {
    expect(normalizeRepositoryDirectory("./packages/cli/")).toBe(
      "packages/cli"
    );
    expect(normalizeRepositoryDirectory("packages//cli")).toBe("packages/cli");
  });

  test("represents the repository root as null", () => {
    expect(normalizeRepositoryDirectory(".")).toBeNull();
    expect(normalizeRepositoryDirectory("./")).toBeNull();
  });

  test("rejects empty, absolute, traversal, Windows, and NUL paths", () => {
    expect(() => normalizeRepositoryDirectory("   ")).toThrow(
      /non-empty relative path/u
    );
    expect(() => normalizeRepositoryDirectory("/packages/cli")).toThrow(
      /must be relative/u
    );
    expect(() => normalizeRepositoryDirectory("C:\\packages\\cli")).toThrow(
      /POSIX/u
    );
    expect(() => normalizeRepositoryDirectory("packages/../cli")).toThrow(
      /traversal/u
    );
    expect(() => normalizeRepositoryDirectory("packages\0cli")).toThrow(/NUL/u);
  });
});
