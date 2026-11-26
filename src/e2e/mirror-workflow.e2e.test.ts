import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { runCli } from "../test-utils/run-cli.js";
import { runGit } from "../test-utils/run-git.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const ENV = { INREPO_NONINTERACTIVE: "1" };

const writeFiles = async function writeFiles(
  root: string,
  files: Record<string, string>
): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = nodePath.join(root, rel);
    await mkdir(nodePath.dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf-8");
  }
};

const commitAll = async function commitAll(
  cwd: string,
  files: Record<string, string>,
  message: string
): Promise<string> {
  await writeFiles(cwd, files);
  await runGit(["add", "-A"], cwd);
  await runGit(["commit", "-q", "-m", message], cwd);
  return runGit(["rev-parse", "HEAD"], cwd);
};

interface MirrorFields {
  directory?: string;
  exclude?: string[];
  git: string;
  keep?: string[];
}

/** Commit a new inrepo.json holding one mirror named "sdk". */
const commitMirrorConfig = function commitMirrorConfig(
  cwd: string,
  mirror: MirrorFields,
  configDir = ""
): Promise<string> {
  return commitAll(
    cwd,
    {
      [nodePath.posix.join(configDir, "inrepo.json")]: `${JSON.stringify({
        mirrors: [{ name: "sdk", ...mirror }],
        packages: [],
      })}\n`,
    },
    "mirror config"
  );
};

/** Paths on `branch` of the bare `target` repository. */
const targetFiles = async function targetFiles(
  target: string,
  branch = "main"
): Promise<string[]> {
  const out = await runGit([
    "--git-dir",
    target,
    "ls-tree",
    "-r",
    "--name-only",
    branch,
  ]);
  return out.split("\n").filter(Boolean);
};

describe("CLI: mirror (e2e)", () => {
  let root: string;
  let host: string;
  let target: string;

  beforeEach(async () => {
    root = await makeTmpDir("inrepo-e2e-mirror-");
    host = nodePath.join(root, "host");
    target = nodePath.join(root, "public.git");
    await runGit(["init", "--bare", "-q", "-b", "main", target]);
    await runGit(["init", "-q", "-b", "main", host]);
    await runGit(["config", "user.name", "Mirror Bot"], host);
    await runGit(["config", "user.email", "mirror@example.com"], host);
    await commitAll(
      host,
      {
        "apps/private/secret.ts": "export const secret = 1;\n",
        "inrepo.json": `${JSON.stringify({
          mirrors: [
            {
              directory: "packages/sdk",
              exclude: [
                String.raw`/\.test\.ts$/`,
                "/(^|/)__tests__$/",
                "internal",
              ],
              git: "../public.git",
              name: "sdk",
            },
          ],
          packages: [],
        })}\n`,
        "packages/sdk/README.md": "# sdk\n",
        "packages/sdk/internal/plan.md": "private plan\n",
        "packages/sdk/src/__tests__/fixture.ts": "fixture\n",
        "packages/sdk/src/index.test.ts": "test\n",
        "packages/sdk/src/index.ts": "export const v = 1;\n",
      },
      "initial"
    );
  });

  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  test("publishes the directory without excluded files, then is up to date", async () => {
    const dry = await runCli(["mirror", "--dry-run"], { cwd: host, env: ENV });
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toMatch(/2 file\(s\) selected, 3 left out/u);
    expect(dry.stdout).toMatch(/A {2}src\/index\.ts/u);
    expect(dry.stdout).toMatch(/would push/u);
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");

    const first = await runCli(["mirror", "sdk"], { cwd: host, env: ENV });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/pushed/u);
    expect(await targetFiles(target)).toEqual(["README.md", "src/index.ts"]);

    const source = await runGit(["rev-parse", "HEAD"], host);
    const message = await runGit([
      "--git-dir",
      target,
      "log",
      "-1",
      "--format=%B",
      "main",
    ]);
    expect(message).toContain(`Inrepo-Mirror-Source: ${source}`);
    expect(
      await runGit(["--git-dir", target, "log", "-1", "--format=%an", "main"])
    ).toBe("Mirror Bot");

    const again = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/is up to date/u);
  });

  test("later runs fast-forward and propagate deletions", async () => {
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );
    const firstTip = await runGit(["--git-dir", target, "rev-parse", "main"]);

    await runGit(["rm", "-q", "packages/sdk/README.md"], host);
    await commitAll(
      host,
      { "packages/sdk/src/extra.ts": "export const e = 1;\n" },
      "second"
    );
    const r = await runCli(["mirror", "-m", "Release 2"], {
      cwd: host,
      env: ENV,
    });
    expect(r.exitCode).toBe(0);
    expect(await targetFiles(target)).toEqual(["src/extra.ts", "src/index.ts"]);
    expect(await runGit(["--git-dir", target, "rev-parse", "main~1"])).toBe(
      firstTip
    );
    expect(
      await runGit(["--git-dir", target, "log", "-1", "--format=%s", "main"])
    ).toBe("Release 2");
  });

  test("refuses to overwrite commits made directly on the target", async () => {
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );
    const clone = nodePath.join(root, "clone");
    await runGit(["clone", "-q", target, clone]);
    await commitAll(clone, { "CONTRIBUTING.md": "hi\n" }, "external fix");
    await runGit(["push", "-q", "origin", "main"], clone);

    await commitAll(host, { "packages/sdk/src/index.ts": "v2\n" }, "v2");
    const blocked = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr + blocked.stdout).toMatch(
      /was not written by inrepo mirror/u
    );

    const forced = await runCli(["mirror", "--overwrite"], {
      cwd: host,
      env: ENV,
    });
    expect(forced.exitCode).toBe(0);
    expect(await targetFiles(target)).toEqual(["README.md", "src/index.ts"]);
  });

  test("refuses to roll the target back to an older source commit", async () => {
    const older = await runGit(["rev-parse", "HEAD"], host);
    await commitAll(host, { "packages/sdk/src/index.ts": "v2\n" }, "v2");
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );

    const r = await runCli(["mirror", "--ref", older], {
      cwd: host,
      env: ENV,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/would roll the mirror back/u);
  });

  test("errors on an unknown mirror name or missing directory", async () => {
    const unknown = await runCli(["mirror", "nope"], { cwd: host, env: ENV });
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr + unknown.stdout).toMatch(/No mirror named "nope"/u);

    await commitAll(
      host,
      {
        "inrepo.json": `${JSON.stringify({
          mirrors: [{ directory: "missing", git: target, name: "sdk" }],
        })}\n`,
      },
      "break config"
    );
    const missing = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr + missing.stdout).toMatch(
      /is not a committed directory/u
    );
  });

  test("ignores repository variables inherited from a git hook", async () => {
    const r = await runCli(["mirror"], {
      cwd: host,
      env: {
        ...ENV,
        GIT_DIR: nodePath.join(host, ".git"),
        GIT_INDEX_FILE: nodePath.join(host, ".git", "index"),
        GIT_WORK_TREE: host,
      },
    });
    expect(r.exitCode).toBe(0);
    expect(await targetFiles(target)).toEqual(["README.md", "src/index.ts"]);
    expect(await runGit(["status", "--porcelain"], host)).toBe("");
  });

  test("works from a config in a subdirectory and over file:// with shallow fetches", async () => {
    await commitMirrorConfig(
      host,
      {
        exclude: [String.raw`/\.test\.ts$/`, "internal"],
        git: `file://${target}`,
      },
      "packages/sdk"
    );
    const cwd = nodePath.join(host, "packages", "sdk");
    expect((await runCli(["mirror"], { cwd, env: ENV })).exitCode).toBe(0);
    await commitAll(host, { "packages/sdk/src/more.ts": "more\n" }, "more");
    expect((await runCli(["mirror"], { cwd, env: ENV })).exitCode).toBe(0);
    expect(await targetFiles(target)).toEqual([
      "README.md",
      "inrepo.json",
      "src/__tests__/fixture.ts",
      "src/index.ts",
      "src/more.ts",
    ]);
  });

  test("keep accepts ./ prefixes", async () => {
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      exclude: [String.raw`/\.test\.ts$/`],
      git: target,
      keep: ["./src/"],
    });
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );
    expect(await targetFiles(target)).toEqual([
      "src/__tests__/fixture.ts",
      "src/index.ts",
    ]);
  });

  test("treats a forged trailer or an amended mirror commit as target changes", async () => {
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );
    const clone = nodePath.join(root, "clone");
    await runGit(["clone", "-q", target, clone]);
    await writeFiles(clone, { "HOTFIX.md": "fix\n" });
    await runGit(["add", "-A"], clone);
    await runGit(["commit", "-q", "--amend", "--no-edit"], clone);
    await runGit(["push", "-q", "-f", "origin", "main"], clone);
    await commitAll(host, { "packages/sdk/src/index.ts": "v2\n" }, "v2");

    const amended = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(amended.exitCode).not.toBe(0);
    expect(amended.stderr + amended.stdout).toMatch(
      /was changed after it was/u
    );

    await writeFiles(clone, { "OTHER.md": "x\n" });
    await runGit(["add", "-A"], clone);
    await runGit(
      ["commit", "-q", "-m", "direct", "-m", "Inrepo-Mirror-Source: HEAD"],
      clone
    );
    await runGit(["push", "-q", "origin", "main"], clone);
    const forged = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(forged.exitCode).not.toBe(0);
    expect(forged.stderr + forged.stdout).toMatch(
      /was not written by inrepo mirror/u
    );
  });

  test("refuses to publish submodules", async () => {
    const head = await runGit(["rev-parse", "HEAD"], host);
    await runGit(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},packages/sdk/vendor/sub`,
      ],
      host
    );
    await runGit(["commit", "-q", "-m", "add gitlink"], host);
    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(
      /submodules cannot be mirrored.*packages\/sdk\/vendor\/sub|vendor\/sub/u
    );
  });

  test("keeps credentials in the target URL out of output", async () => {
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      git: "https://bot:sekrit-token@127.0.0.1:1/acme/sdk.git",
    });
    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).not.toContain("sekrit-token");
  });

  test("refuses a BOM-prefixed name that only looks like a kept path", async () => {
    await runGit(["rm", "-q", "packages/sdk/README.md"], host);
    await commitAll(
      host,
      { "packages/sdk/\uFEFFREADME.md": "private\n" },
      "bom name"
    );
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      git: target,
      keep: ["README.md"],
    });
    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/would publish no files/u);
  });

  test("keeps whitespace in the config directory's path", async () => {
    await commitAll(
      host,
      { " sdk/inner.ts": "spaced\n", "sdk/other.ts": "sibling\n" },
      "spaced dirs"
    );
    await commitMirrorConfig(host, { git: target }, " sdk");
    const cwd = nodePath.join(host, " sdk");
    expect((await runCli(["mirror"], { cwd, env: ENV })).exitCode).toBe(0);
    expect(await targetFiles(target)).toEqual(["inner.ts", "inrepo.json"]);
  });

  test("resolves a plain relative target path against the config directory", async () => {
    await runGit([
      "init",
      "--bare",
      "-q",
      "-b",
      "main",
      nodePath.join(host, "remotes", "sdk.git"),
    ]);
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      git: "remotes/sdk.git",
    });
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );
    expect(
      await targetFiles(nodePath.join(host, "remotes", "sdk.git"))
    ).toContain("src/index.ts");
  });

  test("honors git settings passed through GIT_CONFIG_* variables", async () => {
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      git: `file://${target}`,
    });
    const r = await runCli(["mirror"], {
      cwd: host,
      env: {
        ...ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.file.allow",
        GIT_CONFIG_VALUE_0: "never",
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");
  });

  test("does not advertise private commits while fetching the target", async () => {
    expect((await runCli(["mirror"], { cwd: host, env: ENV })).exitCode).toBe(
      0
    );
    await runGit(["checkout", "-q", "-b", "private-work"], host);
    const privateTip = await commitAll(
      host,
      { "apps/private/next.ts": "unreleased\n" },
      "private work"
    );
    await runGit(["checkout", "-q", "main"], host);
    await commitAll(host, { "packages/sdk/src/index.ts": "v2\n" }, "v2");

    const trace = nodePath.join(root, "packet-trace.txt");
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      git: `file://${target}`,
    });
    const r = await runCli(["mirror", "--overwrite"], {
      cwd: host,
      env: { ...ENV, GIT_TRACE_PACKET: trace },
    });
    expect(r.exitCode).toBe(0);
    const packets = await Bun.file(trace).text();
    expect(packets).toMatch(/fetch/u);
    expect(packets).not.toContain(privateTip);
    expect(packets).not.toMatch(/fetch> have /u);
  });

  test("refuses paths that are not valid UTF-8", async () => {
    const blob = await runGit(
      ["hash-object", "-w", "packages/sdk/README.md"],
      host
    );
    const proc = Bun.spawn(["git", "update-index", "-z", "--index-info"], {
      cwd: host,
      stdin: Buffer.concat([
        Buffer.from(`100644 blob ${blob}\tpackages/sdk/name`),
        Buffer.from([0xff, 0]),
      ]),
    });
    expect(await proc.exited).toBe(0);
    await runGit(["commit", "-q", "-m", "raw name"], host);
    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not valid UTF-8/u);
  });

  test("refuses filters that do not match the published commit's config", async () => {
    const config = nodePath.join(host, "inrepo.json");
    const committed = await Bun.file(config).text();
    await writeFile(config, committed.replace(',"internal"', ""), "utf-8");
    const dirty = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(dirty.exitCode).not.toBe(0);
    expect(dirty.stderr + dirty.stdout).toMatch(
      /does not match the one committed/u
    );
    await writeFile(config, committed, "utf-8");

    await runGit(["checkout", "-q", "-b", "spec-move"], host);
    await commitMirrorConfig(host, {
      directory: "packages/sdk",
      exclude: ["spec"],
      git: "../public.git",
    });
    await runGit(["checkout", "-q", "main"], host);
    const other = await runCli(["mirror", "--ref", "spec-move"], {
      cwd: host,
      env: ENV,
    });
    expect(other.exitCode).not.toBe(0);
    expect(other.stderr + other.stdout).toMatch(
      /does not match the one committed/u
    );
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");
  });

  test("refuses when a push URL rewrite points away from the checked target", async () => {
    const elsewhere = nodePath.join(root, "elsewhere.git");
    await runGit(["init", "--bare", "-q", "-b", "main", elsewhere]);
    const r = await runCli(["mirror"], {
      cwd: host,
      env: {
        ...ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${elsewhere}.pushInsteadOf`,
        // The configured "../public.git", as git receives it.
        GIT_CONFIG_VALUE_0: `${host}${nodePath.sep}../public.git`,
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/different repositories for fetch/u);
    expect(await runGit(["--git-dir", elsewhere, "branch", "--list"])).toBe("");
  });

  test("refuses a looser package.json config when the committed inrepo.json is deleted", async () => {
    await writeFile(
      nodePath.join(host, "package.json"),
      `${JSON.stringify({
        inrepo: {
          mirrors: [
            { directory: "packages/sdk", git: "../public.git", name: "sdk" },
          ],
          packages: [],
        },
        name: "host",
      })}\n`,
      "utf-8"
    );
    await runGit(["add", "package.json"], host);
    await runGit(["commit", "-q", "-m", "stale package.json config"], host);
    // Deleted on disk only: the commit still has the stricter inrepo.json.
    await Bun.file(nodePath.join(host, "inrepo.json")).delete();

    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/does not match the one committed/u);
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");
  });

  test("sees config edits hidden by skip-worktree", async () => {
    await runGit(["update-index", "--skip-worktree", "inrepo.json"], host);
    const config = nodePath.join(host, "inrepo.json");
    const committed = await Bun.file(config).text();
    await writeFile(config, committed.replace(',"internal"', ""), "utf-8");
    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/does not match the one committed/u);
  });

  test("pushes only through the checked remote, whatever global remote config says", async () => {
    const elsewhere = nodePath.join(root, "elsewhere.git");
    await runGit(["init", "--bare", "-q", "-b", "main", elsewhere]);
    const r = await runCli(["mirror"], {
      cwd: host,
      env: {
        ...ENV,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.inrepo-target.pushurl",
        GIT_CONFIG_VALUE_0: elsewhere,
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(await runGit(["--git-dir", elsewhere, "branch", "--list"])).toBe("");
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");
  });

  test("ignores git replace objects when reading the source", async () => {
    const config = nodePath.join(host, "inrepo.json");
    const committed = await Bun.file(config).text();
    const looser = committed.replace(',"internal"', "");
    await writeFile(config, looser, "utf-8");
    const looserBlob = await runGit(["hash-object", "-w", "inrepo.json"], host);
    const committedBlob = await runGit(["rev-parse", "HEAD:inrepo.json"], host);
    await runGit(["replace", committedBlob, looserBlob], host);

    const r = await runCli(["mirror"], { cwd: host, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/does not match the one committed/u);
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");
  });
});
