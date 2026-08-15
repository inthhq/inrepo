import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { runCli } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

describe("CLI: help and argument validation (e2e)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-cli-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("--help prints usage and exits 0", async () => {
    const r = await runCli(["--help"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/inrepo — vendor git dependencies/u);
    expect(r.stdout).toMatch(/Usage:/u);
    expect(r.stdout).toMatch(/inrepo sync/u);
    expect(r.stdout).toMatch(/inrepo verify/u);
    expect(r.stdout).toMatch(/inrepo add/u);
  });

  test("-h is an alias for --help", async () => {
    const r = await runCli(["-h"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage:/u);
  });

  test("--version prints version and exits 0", async () => {
    const r = await runCli(["--version"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/inrepo v/u);
  });

  test("-v is an alias for --version", async () => {
    const r = await runCli(["-v"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/inrepo v/u);
  });

  test("no args (non-TTY, uninitialized) prints help and exits 1", async () => {
    // Spawned CLI runs without a TTY, so the bare-invocation auto-init path is
    // skipped and we fall back to printing usage so CI scripts get a hint.
    const r = await runCli([], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/Usage:/u);
  });

  test("no args (already initialized) prints help and exits 0", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      '{"packages":[]}\n',
      "utf-8"
    );
    const r = await runCli([], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Usage:/u);
  });

  test("init creates inrepo.json when given INREPO_CONFIG=inrepo.json", async () => {
    const r = await runCli(["init"], {
      cwd,
      env: { INREPO_CONFIG: "inrepo.json", INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(true);
    const raw = await readFile(nodePath.join(cwd, "inrepo.json"), "utf-8");
    expect(JSON.parse(raw).packages).toEqual([]);
    expect(await readFile(nodePath.join(cwd, ".gitignore"), "utf-8")).toBe(
      "/inrepo_modules/\n/.inrepo/\n"
    );
    expect(r.stdout).toMatch(/\.gitignore/u);
  });

  test("init is a no-op when already initialized", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      '{"packages":[]}\n',
      "utf-8"
    );
    const r = await runCli(["init"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/already initialized/u);
  });

  test("init in non-TTY without INREPO_CONFIG fails with the setup hint", async () => {
    const r = await runCli(["init"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/first-time setup needs an interactive terminal/u);
  });

  test("init rejects extra args", async () => {
    const r = await runCli(["init", "extra"], {
      cwd,
      env: { INREPO_CONFIG: "inrepo.json", INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/init does not take arguments/u);
  });

  test("unknown command exits 1 with message", async () => {
    const r = await runCli(["frobnicate"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown command: frobnicate/u);
  });

  test("sync rejects extra args", async () => {
    const r = await runCli(["sync", "extra"], {
      cwd,
      env: { INREPO_CONFIG: "inrepo.json", INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/sync does not take arguments/u);
  });

  test("sync accepts --force as a global flag", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [] }),
      "utf-8"
    );
    const r = await runCli(["sync", "--force"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/empty "packages" array/u);
    expect(r.stderr).not.toMatch(/Unknown option: --force/u);
  });

  test("verify rejects extra args", async () => {
    const r = await runCli(["verify", "extra"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/verify does not take arguments/u);
  });

  test("add requires a name", async () => {
    const r = await runCli(["add"], {
      cwd,
      env: { INREPO_CONFIG: "inrepo.json", INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/add requires a package <name>/u);
  });

  test("add rejects unknown options", async () => {
    const r = await runCli(["add", "--bogus", "pkg"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown option: --bogus/u);
  });

  test("add --git requires a URL", async () => {
    const r = await runCli(["add", "--git", "--ref", "main", "pkg"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--git requires a URL/u);
  });

  test("add --ref requires a value", async () => {
    const r = await runCli(["add", "--ref"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--ref requires a value/u);
  });

  test("add validates --repository-directory", async () => {
    const missing = await runCli(["add", "--repository-directory"], { cwd });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/--repository-directory requires a path/u);

    const unsafe = await runCli(
      ["add", "--repository-directory", "../pkg", "pkg"],
      {
        cwd,
      }
    );
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.stderr).toMatch(/--repository-directory.*traversal/u);
  });

  test("sync without config fails with first-time-setup hint in non-interactive mode", async () => {
    const r = await runCli(["sync"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/first-time setup needs an interactive terminal/u);
  });

  test("sync with empty inrepo.json packages array reports a friendly empty-config error", async () => {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      JSON.stringify({ packages: [] }),
      "utf-8"
    );
    const r = await runCli(["sync"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/empty "packages" array/u);
  });

  test("sync with empty package.json#inrepo packages array reports the same error", async () => {
    await writeFile(
      nodePath.join(cwd, "package.json"),
      JSON.stringify({ inrepo: { packages: [] }, name: "host" }),
      "utf-8"
    );
    const r = await runCli(["sync"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/empty "packages" array/u);
  });

  test("verify with no lockfile reports nothing-to-verify", async () => {
    const r = await runCli(["verify"], { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/No modules in inrepo\.lock\.json/u);
  });

  test("sync with malformed inrepo.json surfaces a clear error", async () => {
    await writeFile(nodePath.join(cwd, "inrepo.json"), "{ broken", "utf-8");
    const r = await runCli(["sync"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Invalid JSON in inrepo\.json/u);
  });

  test("sync with malformed package.json surfaces a clear error", async () => {
    await writeFile(nodePath.join(cwd, "package.json"), "{ broken", "utf-8");
    const r = await runCli(["sync"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Invalid package\.json/u);
  });

  test('sync with empty package.json surfaces a clear "file is empty" error (not a first-time-setup hint)', async () => {
    await writeFile(nodePath.join(cwd, "package.json"), "   \n", "utf-8");
    const r = await runCli(["sync"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Invalid package\.json: file is empty/u);
    expect(r.stderr).not.toMatch(
      /first-time setup needs an interactive terminal/u
    );
  });
});
