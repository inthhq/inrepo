import { describe, expect, test } from "bun:test";

import { classifyDependencySpecifier } from "./dependency-specifier.js";

describe("classifyDependencySpecifier", () => {
  test.each([
    "^1.0.0",
    "~2.3",
    "1.x",
    "*",
    ">=1 <2",
    "1.0.0 - 2.0.0",
    "^1 || ^2",
  ])("accepts the semver range %p", (range) => {
    expect(classifyDependencySpecifier(range)).toEqual({
      range,
      supported: true,
    });
  });

  test("treats an empty specifier as *", () => {
    expect(classifyDependencySpecifier("  ")).toEqual({
      range: "*",
      supported: true,
    });
  });

  test.each([
    ["workspace:^", /workspace protocol/u],
    ["file:../local", /local path specifiers/u],
    ["link:../local", /local path specifiers/u],
    ["catalog:default", /catalog specifiers/u],
    ["npm:other@^1.0.0", /npm alias specifiers/u],
    ["git+https://github.com/o/r.git", /git specifiers/u],
    ["github:owner/repo", /git host shorthand/u],
    ["https://example.com/pkg.tgz", /tarball URL specifiers/u],
    ["owner/repo#semver:^1", /git host shorthand/u],
    ["latest", /not a semver range/u],
    ["next", /not a semver range/u],
  ])("rejects %p", (specifier, reason) => {
    const result = classifyDependencySpecifier(specifier);
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.reason).toMatch(reason);
    }
  });
});
