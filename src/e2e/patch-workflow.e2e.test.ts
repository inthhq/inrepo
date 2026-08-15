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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  bootstrapHostPackageJson,
  envFor,
  MODES,
  writeConfig,
} from "../test-utils/e2e-harness.js";
import { makeLocalGitFixture } from "../test-utils/local-git-fixture.js";
import type { LocalGitFixture } from "../test-utils/local-git-fixture.js";
import { runCli } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

for (const mode of MODES) {
  describe(`CLI: patch workflow (e2e) [${mode}]`, () => {
    let fx: LocalGitFixture;
    let cwd: string;

    beforeAll(async () => {
      fx = await makeLocalGitFixture(`inrepo-patch-${mode}-`);
    });

    afterAll(async () => {
      await fx.cleanup();
    });

    beforeEach(async () => {
      cwd = await makeTmpDir(
        `inrepo-patch-e2e-${mode === "inrepo.json" ? "ij" : "pj"}-`
      );
      await bootstrapHostPackageJson(cwd);
      await writeConfig(cwd, mode, {
        packages: [{ git: fx.url, name: "upstream" }],
      });
    });

    afterEach(async () => {
      await cleanupTmpDir(cwd);
    });

    test("sync -> edit -> patch -m -> resync preserves text, binary files, and deletions", async () => {
      expect(
        (await runCli(["sync"], { cwd, env: envFor(mode) })).exitCode
      ).toBe(0);

      const moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
      await writeFile(
        nodePath.join(moduleDir, "src", "index.ts"),
        "export const v = 99;\n",
        "utf-8"
      );
      await writeFile(
        nodePath.join(moduleDir, "logo.bin"),
        new Uint8Array([0x89, 0x50, 0x00, 0x01])
      );
      await writeFile(
        nodePath.join(moduleDir, "src", "local.ts"),
        "export const local = true;\n",
        "utf-8"
      );
      await rm(nodePath.join(moduleDir, "docs", "guide.md"));

      const patch = await runCli(
        ["patch", "upstream", "-m", "Vendor local tweaks"],
        {
          cwd,
          env: envFor(mode),
        }
      );
      expect(patch.exitCode).toBe(0);

      const seriesDir = nodePath.join(
        cwd,
        "inrepo_patches",
        "upstream",
        "series"
      );
      expect(await readdir(seriesDir)).toEqual([
        "0001-Vendor-local-tweaks.patch",
      ]);
      expect(
        await readFile(
          nodePath.join(seriesDir, "0001-Vendor-local-tweaks.patch"),
          "utf-8"
        )
      ).toContain("Subject: [PATCH] Vendor local tweaks");

      expect(
        (await runCli(["sync"], { cwd, env: envFor(mode) })).exitCode
      ).toBe(0);
      expect(
        await readFile(nodePath.join(moduleDir, "src", "index.ts"), "utf-8")
      ).toBe("export const v = 99;\n");
      expect(await readFile(nodePath.join(moduleDir, "logo.bin"))).toEqual(
        Buffer.from([0x89, 0x50, 0x00, 0x01])
      );
      expect(existsSync(nodePath.join(moduleDir, "docs", "guide.md"))).toBe(
        false
      );
      expect(
        await readFile(nodePath.join(moduleDir, "src", "local.ts"), "utf-8")
      ).toBe("export const local = true;\n");
    });

    test("packages still on a legacy overlay keep capturing whole-file snapshots", async () => {
      const overlayDir = nodePath.join(cwd, "inrepo_patches", "upstream");
      await mkdir(nodePath.join(overlayDir, "src"), { recursive: true });
      await writeFile(
        nodePath.join(overlayDir, "src", "index.ts"),
        "export const v = 42;\n",
        "utf-8"
      );
      expect(
        (await runCli(["sync"], { cwd, env: envFor(mode) })).exitCode
      ).toBe(0);

      const moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
      await writeFile(
        nodePath.join(moduleDir, "src", "index.ts"),
        "export const v = 43;\n",
        "utf-8"
      );
      await rm(nodePath.join(moduleDir, "docs", "guide.md"));

      const patch = await runCli(["patch", "upstream"], {
        cwd,
        env: envFor(mode),
      });
      expect(patch.exitCode).toBe(0);
      expect(existsSync(nodePath.join(overlayDir, "series"))).toBe(false);
      expect(
        await readFile(nodePath.join(overlayDir, "src", "index.ts"), "utf-8")
      ).toBe("export const v = 43;\n");
      expect(
        await readFile(nodePath.join(overlayDir, ".inrepo-deletions"), "utf-8")
      ).toBe("docs/guide.md\n");

      // -m has nowhere to go in the snapshot format, so it is reported as ignored.
      await writeFile(
        nodePath.join(moduleDir, "src", "index.ts"),
        "export const v = 44;\n",
        "utf-8"
      );
      const withMessage = await runCli(
        ["patch", "upstream", "-m", "Bump again"],
        {
          cwd,
          env: envFor(mode),
        }
      );
      expect(withMessage.exitCode).toBe(0);
      expect(withMessage.stderr).toMatch(/Ignoring -m for "upstream"/u);
      expect(
        await readFile(nodePath.join(overlayDir, "src", "index.ts"), "utf-8")
      ).toBe("export const v = 44;\n");
    });

    test("sync refuses to overwrite uncaptured edits without --force", async () => {
      expect(
        (await runCli(["sync"], { cwd, env: envFor(mode) })).exitCode
      ).toBe(0);

      const moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
      await writeFile(
        nodePath.join(moduleDir, "src", "index.ts"),
        "export const v = 77;\n",
        "utf-8"
      );

      const r = await runCli(["sync"], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(
        /uncaptured edits in "inrepo_modules\/upstream"/u
      );
    });

    test("sync --force snapshots a backup before rebuilding", async () => {
      expect(
        (await runCli(["sync"], { cwd, env: envFor(mode) })).exitCode
      ).toBe(0);

      const moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
      await writeFile(
        nodePath.join(moduleDir, "src", "index.ts"),
        "export const v = 55;\n",
        "utf-8"
      );

      const r = await runCli(["sync", "--force"], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(0);

      const backupRoot = nodePath.join(cwd, ".inrepo", "backups");
      const backups = await readdir(backupRoot);
      expect(backups.length).toBe(1);
      expect(
        await readFile(
          nodePath.join(backupRoot, backups[0], "src", "index.ts"),
          "utf-8"
        )
      ).toBe("export const v = 55;\n");
    });

    test("patch fails loudly when both overlay and generated module changed", async () => {
      expect(
        (await runCli(["sync"], { cwd, env: envFor(mode) })).exitCode
      ).toBe(0);

      const overlayDir = nodePath.join(
        cwd,
        "inrepo_patches",
        "upstream",
        "src"
      );
      await mkdir(overlayDir, { recursive: true });
      await writeFile(
        nodePath.join(overlayDir, "index.ts"),
        "export const v = 22;\n",
        "utf-8"
      );

      const moduleDir = nodePath.join(cwd, "inrepo_modules", "upstream");
      await writeFile(
        nodePath.join(moduleDir, "src", "index.ts"),
        "export const v = 33;\n",
        "utf-8"
      );

      const r = await runCli(["patch", "upstream"], { cwd, env: envFor(mode) });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(
        /both "inrepo_patches\/upstream" and "inrepo_modules\/upstream" changed/u
      );
    });
  });
}
