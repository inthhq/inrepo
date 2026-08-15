import { describe, expect, test } from "bun:test";

import { resolveExistingRootPin } from "./with-deps.js";

describe("resolveExistingRootPin", () => {
  const lock = {
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    gitUrl: "git@private:alpha.git",
    ref: "v1.0.0",
  };

  test("defaults git, ref, and commit to the recorded pin", () => {
    expect(resolveExistingRootPin({}, lock)).toEqual({
      commit: lock.commit,
      git: lock.gitUrl,
      ref: lock.ref,
    });
  });

  test("honors a caller-supplied pin even when git is already filled in", () => {
    expect(
      resolveExistingRootPin(
        { commit: lock.commit, git: lock.gitUrl, ref: lock.ref },
        lock
      )
    ).toEqual({
      commit: lock.commit,
      git: lock.gitUrl,
      ref: lock.ref,
    });
  });

  test("fetches a moving tip when --git is passed", () => {
    expect(
      resolveExistingRootPin({ git: "https://example.com/alpha.git" }, lock)
    ).toEqual({
      commit: null,
      git: "https://example.com/alpha.git",
      ref: undefined,
    });
  });

  test("fetches a moving tip when --ref is passed", () => {
    expect(resolveExistingRootPin({ ref: "v2.0.0" }, lock)).toEqual({
      commit: null,
      git: lock.gitUrl,
      ref: "v2.0.0",
    });
  });

  test("resolves from npm when nothing is recorded", () => {
    expect(resolveExistingRootPin({})).toEqual({
      commit: null,
      git: undefined,
      ref: undefined,
    });
  });
});
