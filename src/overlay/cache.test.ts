import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rename, symlink } from "node:fs/promises";
import nodePath from "node:path";

import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import { runGit } from "../test-utils/run-git.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { discoverRepositoryDirectory, ensurePristine } from "./cache.js";

describe("ensurePristine", () => {
  let fx: LocalGitFixture | undefined;
  let cwd: string;

  const requireFixture = function requireFixture(): LocalGitFixture {
    expect(fx).toBeDefined();
    if (fx == null) {
      throw new Error("Local git fixture was not initialized");
    }
    return fx;
  };

  beforeAll(async () => {
    fx = await makeLocalGitFixture("inrepo-cache-fixture-");
  });

  afterAll(async () => {
    if (fx) {
      await fx.cleanup();
    }
  });

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-cache-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("builds the pristine cache at a pinned commit", async () => {
    const fixture = requireFixture();
    const pristine = await ensurePristine({
      commit: fixture.c1,
      cwd,
      exclude: [],
      gitUrl: fixture.url,
      keep: ["src", "package.json"],
      name: "upstream",
      ref: null,
    });

    expect(pristine.commit).toBe(fixture.c1);
    expect(
      await readFile(nodePath.join(pristine.dir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 1;\n");
    expect(existsSync(nodePath.join(pristine.dir, "package.json"))).toBe(true);
    expect(existsSync(nodePath.join(pristine.dir, "README.md"))).toBe(false);
  });

  test("creates the cache parent for a scoped package", async () => {
    const fixture = requireFixture();
    const pristine = await ensurePristine({
      commit: fixture.c1,
      cwd,
      exclude: [],
      gitUrl: fixture.url,
      keep: [],
      name: "@scope/upstream",
      ref: null,
    });

    expect(pristine.dir).toBe(
      nodePath.join(cwd, ".inrepo", "cache", "@scope", "upstream")
    );
    expect(
      await readFile(nodePath.join(pristine.dir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 1;\n");
  });

  test("rebuilds when the pinned commit or filters change", async () => {
    const fixture = requireFixture();
    const first = await ensurePristine({
      commit: fixture.c1,
      cwd,
      exclude: [],
      gitUrl: fixture.url,
      keep: ["src", "package.json"],
      name: "upstream",
      ref: null,
    });
    expect(
      await readFile(nodePath.join(first.dir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 1;\n");

    const second = await ensurePristine({
      commit: fixture.c2,
      cwd,
      exclude: [],
      gitUrl: fixture.url,
      keep: ["src", "package.json", "CHANGELOG.md"],
      name: "upstream",
      ref: null,
    });
    expect(second.commit).toBe(fixture.c2);
    expect(
      await readFile(nodePath.join(second.dir, "src", "index.ts"), "utf-8")
    ).toBe("export const v = 2;\n");
    expect(existsSync(nodePath.join(second.dir, "CHANGELOG.md"))).toBe(true);

    const third = await ensurePristine({
      commit: fixture.c2,
      cwd,
      exclude: [],
      gitUrl: fixture.url,
      keep: ["src"],
      name: "upstream",
      ref: null,
    });
    expect(existsSync(nodePath.join(third.dir, "package.json"))).toBe(false);
  });

  test("shares an exact repository snapshot while projecting package-relative views", async () => {
    const mono = await makeLocalGitFixture("inrepo-cache-monorepo-");
    try {
      const commit = await mono.commitUpstream(
        {
          "packages/a/docs/a.md": "# a\n",
          "packages/a/package.json": '{"name":"@scope/a"}\n',
          "packages/a/src/index.ts": 'export const packageName = "a";\n',
          "packages/b/package.json": '{"name":"@scope/b"}\n',
          "packages/b/src/index.ts": 'export const packageName = "b";\n',
        },
        "add workspace packages"
      );

      const first = await ensurePristine({
        commit,
        cwd,
        exclude: [],
        gitUrl: mono.url,
        keep: ["package.json", "src"],
        name: "@scope/a",
        repositoryDirectory: "packages/a",
      });
      expect(
        await readFile(nodePath.join(first.dir, "src", "index.ts"), "utf-8")
      ).toContain('"a"');
      expect(existsSync(nodePath.join(first.dir, "docs"))).toBe(false);
      expect(existsSync(nodePath.join(first.dir, "packages"))).toBe(false);

      // Prove the second package uses the raw content-addressed snapshot rather
      // than cloning the same repository commit again.
      await rename(mono.url, `${mono.url}.offline`);
      const second = await ensurePristine({
        commit,
        cwd,
        exclude: [],
        gitUrl: mono.url,
        keep: [],
        name: "@scope/b",
        repositoryDirectory: "packages/b",
      });
      expect(
        await readFile(nodePath.join(second.dir, "src", "index.ts"), "utf-8")
      ).toContain('"b"');

      // repositoryDirectory participates in package-view invalidation too.
      const retargeted = await ensurePristine({
        commit,
        cwd,
        exclude: [],
        gitUrl: mono.url,
        keep: [],
        name: "@scope/a",
        repositoryDirectory: "packages/b",
      });
      expect(
        await readFile(
          nodePath.join(retargeted.dir, "src", "index.ts"),
          "utf-8"
        )
      ).toContain('"b"');
    } finally {
      await mono.cleanup();
    }
  });

  test("discovers one exact package directory at an immutable commit", async () => {
    const mono = await makeLocalGitFixture("inrepo-cache-discovery-");
    try {
      const commit = await mono.commitUpstream(
        {
          "package.json": '{"name":"workspace-root","version":"1.0.0"}\n',
          "packages/other/package.json":
            '{"name":"@scope/other","version":"2.2.0"}\n',
          "packages/schema/package.json":
            '{"name":"@scope/schema","version":"2.2.0"}\n',
        },
        "add discoverable package"
      );
      expect(
        await discoverRepositoryDirectory({
          commit,
          cwd,
          gitUrl: mono.url,
          name: "@scope/schema",
          version: "2.2.0",
        })
      ).toBe("packages/schema");
      expect(
        await discoverRepositoryDirectory({
          commit,
          cwd,
          gitUrl: mono.url,
          name: "workspace-root",
          version: "1.0.0",
        })
      ).toBeNull();
    } finally {
      await mono.cleanup();
    }
  });

  test("rejects a package-subtree symlink that escapes to another repository path", async () => {
    const mono = await makeLocalGitFixture("inrepo-cache-symlink-");
    try {
      await mono.commitUpstream(
        { "packages/a/package.json": '{"name":"a"}\n' },
        "add workspace package"
      );
      await symlink(
        "../../README.md",
        nodePath.join(mono.work, "packages", "a", "leak")
      );
      await runGit(["add", "--all", "."], mono.work);
      await runGit(["commit", "-m", "add escaping symlink"], mono.work);
      await runGit(["push", "origin", "HEAD"], mono.work);
      const commit = await runGit(["rev-parse", "HEAD"], mono.work);

      await expect(
        ensurePristine({
          commit,
          cwd,
          exclude: [],
          gitUrl: mono.url,
          keep: [],
          name: "a",
          repositoryDirectory: "packages/a",
        })
      ).rejects.toThrow(/symlink escaping module root at "leak"/u);
    } finally {
      await mono.cleanup();
    }
  });
});
