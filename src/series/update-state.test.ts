import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  seriesDirPath,
  updateDirPath,
  updateSeriesSnapshotPath,
  updateStatePath,
} from "../overlay/overlay-paths.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import {
  clearUpdate,
  isUpdateInProgress,
  readUpdateState,
  restoreUpdateSeries,
  snapshotUpdateSeries,
  updateInProgressError,
  writeUpdateState,
} from "./update-state.js";
import type { UpdateState } from "./update-state.js";

const sampleState = function sampleState(name: string): UpdateState {
  return {
    gitUrl: "https://example.test/repo.git",
    name,
    newBase: "c".repeat(40),
    newCommit: "b".repeat(40),
    oldCommit: "a".repeat(40),
    persistRef: true,
    ref: "main",
    repositoryDirectory: "packages/pkg",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
};

describe("update state", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-update-state-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("round-trips through .inrepo/updates/<package>/state.json", async () => {
    expect(isUpdateInProgress(cwd, "pkg")).toBe(false);
    expect(await readUpdateState(cwd, "pkg")).toBeNull();

    await writeUpdateState(cwd, "pkg", sampleState("pkg"));

    expect(updateStatePath(cwd, "pkg")).toBe(
      nodePath.join(cwd, ".inrepo", "updates", "pkg", "state.json")
    );
    expect(isUpdateInProgress(cwd, "pkg")).toBe(true);
    expect(await readUpdateState(cwd, "pkg")).toEqual(sampleState("pkg"));
  });

  test("keeps scoped packages in their own directory", async () => {
    await writeUpdateState(cwd, "@scope/pkg", sampleState("@scope/pkg"));
    expect(updateDirPath(cwd, "@scope/pkg")).toBe(
      nodePath.join(cwd, ".inrepo", "updates", "@scope", "pkg")
    );
    expect(isUpdateInProgress(cwd, "@scope/pkg")).toBe(true);
    expect(isUpdateInProgress(cwd, "pkg")).toBe(false);
  });

  test("clearing removes the scratch repository along with the state", async () => {
    await writeUpdateState(cwd, "pkg", sampleState("pkg"));
    const repoFile = nodePath.join(
      updateDirPath(cwd, "pkg"),
      "repo",
      "file.txt"
    );
    await mkdir(nodePath.join(updateDirPath(cwd, "pkg"), "repo"), {
      recursive: true,
    });
    await writeFile(repoFile, "work in progress\n", "utf-8");

    await clearUpdate(cwd, "pkg");

    expect(existsSync(updateDirPath(cwd, "pkg"))).toBe(false);
    expect(isUpdateInProgress(cwd, "pkg")).toBe(false);
  });

  test("rejects a state file that is missing required fields", async () => {
    await mkdir(updateDirPath(cwd, "pkg"), { recursive: true });
    await writeFile(updateStatePath(cwd, "pkg"), '{"name":"pkg"}\n', "utf-8");
    await expect(readUpdateState(cwd, "pkg")).rejects.toThrow(
      /missing required field "gitUrl"/u
    );
  });

  test("rejects a state file that is not JSON", async () => {
    await mkdir(updateDirPath(cwd, "pkg"), { recursive: true });
    await writeFile(updateStatePath(cwd, "pkg"), "{ broken", "utf-8");
    await expect(readUpdateState(cwd, "pkg")).rejects.toThrow(
      /Invalid update state/u
    );
  });

  test("snapshot and restore replace a rewritten series", async () => {
    const live = seriesDirPath(cwd, "pkg");
    await mkdir(live, { recursive: true });
    await writeFile(nodePath.join(live, "0001-old.patch"), "old\n", "utf-8");

    await snapshotUpdateSeries(cwd, "pkg");
    expect(
      await readFile(
        nodePath.join(updateSeriesSnapshotPath(cwd, "pkg"), "0001-old.patch"),
        "utf-8"
      )
    ).toBe("old\n");

    await rm(nodePath.join(live, "0001-old.patch"));
    await writeFile(nodePath.join(live, "0001-new.patch"), "new\n", "utf-8");

    await restoreUpdateSeries(cwd, "pkg");
    expect(await (await readdir(live)).toSorted()).toEqual(["0001-old.patch"]);
    expect(await readFile(nodePath.join(live, "0001-old.patch"), "utf-8")).toBe(
      "old\n"
    );
  });

  test("restore is a no-op when no snapshot was taken", async () => {
    const live = seriesDirPath(cwd, "pkg");
    await mkdir(live, { recursive: true });
    await writeFile(nodePath.join(live, "0001-live.patch"), "live\n", "utf-8");

    await restoreUpdateSeries(cwd, "pkg");
    expect(await readdir(live)).toEqual(["0001-live.patch"]);
  });

  test("updateInProgressError names --continue and --abort", () => {
    const err = updateInProgressError(cwd, "pkg", "patching");
    expect(err.message).toContain("already in progress");
    expect(err.message).toContain("inrepo update pkg --continue");
    expect(err.message).toContain("inrepo update pkg --abort");
    expect(err.message).toContain("before patching");
  });
});
