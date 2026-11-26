import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { isJsonObject } from "../json/unknown.js";
import type { JsonObject, JsonValue } from "../json/unknown.js";
import { runCli } from "../test-utils/run-cli.js";
import type { RunCliResult } from "../test-utils/run-cli.js";
import { runGit } from "../test-utils/run-git.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const ENV = { INREPO_NONINTERACTIVE: "1" };

/** stdout must be exactly one JSON document. */
const parseEnvelope = function parseEnvelope(r: RunCliResult): JsonObject {
  // SAFETY: JSON.parse produces a JSON value from CLI stdout.
  const parsed = JSON.parse(r.stdout) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new TypeError(`expected a JSON object on stdout, got: ${r.stdout}`);
  }
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.command).toBe("mirror");
  return parsed;
};

const objectAt = function objectAt(value: JsonValue | undefined): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`expected an object, got: ${JSON.stringify(value)}`);
  }
  return value;
};

/** The single mirror result in a success envelope. */
const onlyMirror = function onlyMirror(envelope: JsonObject): JsonObject {
  const { mirrors } = objectAt(envelope.data);
  if (!Array.isArray(mirrors) || mirrors.length !== 1) {
    throw new TypeError(`expected one mirror, got: ${JSON.stringify(mirrors)}`);
  }
  return objectAt(mirrors[0]);
};

const commitAll = async function commitAll(
  cwd: string,
  files: Record<string, string>,
  message: string
): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = nodePath.join(cwd, rel);
    await mkdir(nodePath.dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf-8");
  }
  await runGit(["add", "-A"], cwd);
  await runGit(["commit", "-q", "-m", message], cwd);
};

const configWith = function configWith(git: string): string {
  return `${JSON.stringify({
    mirrors: [
      {
        directory: "packages/sdk",
        exclude: [String.raw`/\.test\.ts$/`],
        git,
        name: "sdk",
      },
    ],
    packages: [],
  })}\n`;
};

describe("CLI --json: mirror (e2e)", () => {
  let root: string;
  let host: string;
  let target: string;

  const cli = async function cli(args: string[]): Promise<RunCliResult> {
    return await runCli(["mirror", "--json", ...args], {
      cwd: host,
      env: ENV,
    });
  };

  beforeEach(async () => {
    root = await makeTmpDir("inrepo-e2e-json-mirror-");
    host = nodePath.join(root, "host");
    target = nodePath.join(root, "public.git");
    await runGit(["init", "--bare", "-q", "-b", "main", target]);
    await runGit(["init", "-q", "-b", "main", host]);
    await runGit(["config", "user.name", "Mirror Bot"], host);
    await runGit(["config", "user.email", "mirror@example.com"], host);
    await commitAll(
      host,
      {
        "inrepo.json": configWith("../public.git"),
        "packages/sdk/README.md": "# sdk\n",
        "packages/sdk/src/index.test.ts": "test\n",
        "packages/sdk/src/index.ts": "export const v = 1;\n",
      },
      "initial"
    );
  });

  afterEach(async () => {
    await cleanupTmpDir(root);
  });

  test("--dry-run reports the plan in one envelope and pushes nothing", async () => {
    const r = await cli(["--dry-run"]);
    expect(r.exitCode).toBe(0);
    const envelope = parseEnvelope(r);
    expect(envelope.ok).toBe(true);
    expect(envelope.dryRun).toBe(true);
    const mirror = onlyMirror(envelope);
    expect(mirror.name).toBe("sdk");
    expect(mirror.action).toBe("would-push");
    expect(mirror.branch).toBe("main");
    expect(mirror.previousTip).toBeNull();
    expect(mirror.includedCount).toBe(2);
    expect(mirror.excludedCount).toBe(1);
    expect(mirror.changes).toEqual([
      { path: "README.md", status: "added" },
      { path: "src/index.ts", status: "added" },
    ]);
    expect(await runGit(["--git-dir", target, "branch", "--list"])).toBe("");
  });

  test("a real run reports the pushed commit, then up-to-date", async () => {
    const first = onlyMirror(parseEnvelope(await cli([])));
    expect(first.action).toBe("pushed");
    expect(first.commit).toBe(
      await runGit(["--git-dir", target, "rev-parse", "main"])
    );
    const again = onlyMirror(parseEnvelope(await cli([])));
    expect(again.action).toBe("up-to-date");
    expect(again.commit).toBeNull();
    expect(again.changes).toEqual([]);
  });

  test("an unknown mirror is MIRROR_NOT_FOUND with exit 2", async () => {
    const r = await cli(["nope"]);
    expect(r.exitCode).toBe(2);
    const envelope = parseEnvelope(r);
    expect(envelope.ok).toBe(false);
    const error = objectAt(envelope.error);
    expect(error.code).toBe("MIRROR_NOT_FOUND");
    expect(objectAt(error.details).known).toEqual(["sdk"]);
  });

  test("a changed target is MIRROR_TARGET_CHANGED with exit 3 and a next command", async () => {
    expect((await cli([])).exitCode).toBe(0);
    const clone = nodePath.join(root, "clone");
    await runGit(["clone", "-q", target, clone]);
    await commitAll(clone, { "CONTRIBUTING.md": "hi\n" }, "external fix");
    await runGit(["push", "-q", "origin", "main"], clone);
    await commitAll(host, { "packages/sdk/src/index.ts": "v2\n" }, "v2");

    const r = await cli([]);
    expect(r.exitCode).toBe(3);
    const error = objectAt(parseEnvelope(r).error);
    expect(error.code).toBe("MIRROR_TARGET_CHANGED");
    expect(error.nextCommand).toBe("inrepo mirror sdk --overwrite");
    expect(objectAt(error.details).reason).toBe("foreign-tip");
  });

  test("an unreachable target is UPSTREAM_UNAVAILABLE with exit 4 and no credentials", async () => {
    await commitAll(
      host,
      { "inrepo.json": configWith("https://bot:sekrit@127.0.0.1:1/x.git") },
      "unreachable"
    );
    const r = await cli([]);
    expect(r.exitCode).toBe(4);
    const error = objectAt(parseEnvelope(r).error);
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(r.stdout + r.stderr).not.toContain("sekrit");
  });
});
