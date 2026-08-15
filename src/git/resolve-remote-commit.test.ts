import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import {
  parseLsRemote,
  pickRemoteCommit,
  resolveRemoteCommit,
} from "./resolve-remote-commit.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("parseLsRemote", () => {
  test("reads tab-separated commit/ref rows and ignores noise", () => {
    expect(
      parseLsRemote(
        `${SHA_A}\trefs/heads/main\nwarning: whatever\n${SHA_B}\tHEAD\n`
      )
    ).toEqual([
      { commit: SHA_A, ref: "refs/heads/main" },
      { commit: SHA_B, ref: "HEAD" },
    ]);
  });

  test("lowercases commit ids", () => {
    expect(parseLsRemote(`${"A".repeat(40)}\tHEAD`)[0].commit).toBe(SHA_A);
  });
});

describe("pickRemoteCommit", () => {
  test("prefers a branch over a tag of the same name", () => {
    const rows = [
      { commit: SHA_A, ref: "refs/tags/main" },
      { commit: SHA_B, ref: "refs/heads/main" },
    ];
    expect(pickRemoteCommit(rows, "main")).toBe(SHA_B);
  });

  test("peels an annotated tag to the commit it points at", () => {
    const rows = [
      { commit: SHA_A, ref: "refs/tags/v1" },
      { commit: SHA_C, ref: "refs/tags/v1^{}" },
    ];
    expect(pickRemoteCommit(rows, "v1")).toBe(SHA_C);
  });

  test("matches HEAD by its advertised name", () => {
    expect(pickRemoteCommit([{ commit: SHA_A, ref: "HEAD" }], "HEAD")).toBe(
      SHA_A
    );
  });

  test("returns null when the remote advertised nothing", () => {
    expect(pickRemoteCommit([], "main")).toBeNull();
  });
});

describe("resolveRemoteCommit", () => {
  let fx: LocalGitFixture;

  beforeAll(async () => {
    fx = await makeLocalGitFixture("inrepo-lsremote-");
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("resolves a branch to its current tip", async () => {
    expect(await resolveRemoteCommit(fx.url, "main")).toBe(fx.c2);
  });

  test("resolves the default branch when no ref is given", async () => {
    expect(await resolveRemoteCommit(fx.url, null)).toBe(fx.c2);
  });

  test("follows the branch as upstream moves", async () => {
    const moved = await fx.commitUpstream({ "NOTES.md": "# notes\n" }, "third");
    expect(await resolveRemoteCommit(fx.url, "main")).toBe(moved);
  });

  test("a full commit id resolves to itself without touching the remote", async () => {
    expect(
      await resolveRemoteCommit("this-url-does-not-exist", fx.c1.toUpperCase())
    ).toBe(fx.c1);
  });

  test("explains that an abbreviated commit id has no moving tip", async () => {
    await expect(
      resolveRemoteCommit(fx.url, fx.c1.slice(0, 10))
    ).rejects.toThrow(/looks like a commit id.*--ref/su);
  });

  test("reports an unknown ref", async () => {
    await expect(resolveRemoteCommit(fx.url, "no-such-branch")).rejects.toThrow(
      /Could not resolve ref "no-such-branch"/u
    );
  });
});
