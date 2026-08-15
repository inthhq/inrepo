import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { materializePackage } from "./vendor.js";

describe("materializePackage repository source selection", () => {
  let cwd: string;
  let oldRepository: LocalGitFixture;
  let newRepository: LocalGitFixture;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-vendor-source-");
    oldRepository = await makeLocalGitFixture("inrepo-vendor-old-source-");
    newRepository = await makeLocalGitFixture("inrepo-vendor-new-source-");
  });

  afterEach(async () => {
    await Promise.all([
      cleanupTmpDir(cwd),
      oldRepository.cleanup(),
      newRepository.cleanup(),
    ]);
  });

  test("does not inherit a locked repositoryDirectory after git changes repositories", async () => {
    await materializePackage(
      cwd,
      { git: newRepository.url, name: "upstream" },
      [],
      [],
      {
        force: false,
        lockEntry: {
          commit: oldRepository.c2,
          gitUrl: oldRepository.url,
          ref: null,
          repositoryDirectory: "packages/upstream",
          source: "upstream",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        mode: "sync",
      }
    );

    const moduleRoot = nodePath.join(cwd, "inrepo_modules", "upstream");
    expect(
      await readFile(nodePath.join(moduleRoot, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 2;\n");
    expect(existsSync(nodePath.join(moduleRoot, "packages"))).toBe(false);

    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const lock = JSON.parse(
      await readFile(nodePath.join(cwd, "inrepo.lock.json"), "utf-8")
    ) as {
      modules: Record<string, { gitUrl: string; repositoryDirectory?: string }>;
    };
    expect(lock.modules.upstream.gitUrl).toBe(newRepository.url);
    expect(lock.modules.upstream.repositoryDirectory).toBeUndefined();
  });
});
