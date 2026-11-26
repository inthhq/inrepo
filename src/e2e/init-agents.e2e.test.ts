import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  renderAgentsBlock,
} from "../agents/agents-block.js";
import type { JsonObject } from "../json/unknown.js";
import { runCli } from "../test-utils/run-cli.js";
import type { RunCliResult } from "../test-utils/run-cli.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";

const INIT_ENV = { INREPO_CONFIG: "inrepo.json", INREPO_NONINTERACTIVE: "1" };

interface Envelope {
  schemaVersion: number;
  ok: boolean;
  command: string;
  data?: JsonObject;
  error?: { code: string; message: string; hint?: string };
}

/** Parse the single JSON document `--json` prints on stdout. */
const envelope = function envelope(result: RunCliResult): Envelope {
  // SAFETY: --json prints exactly one envelope object on stdout.
  return JSON.parse(result.stdout) as Envelope;
};

const countOf = function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
};

describe("CLI: init --agents (e2e)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-e2e-init-agents-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  const read = function read(file: string): Promise<string> {
    return readFile(nodePath.join(cwd, file), "utf-8");
  };

  test("creates config and AGENTS.md, and reports both under --json", async () => {
    const r = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(r.exitCode).toBe(0);
    expect(envelope(r)).toEqual({
      command: "init",
      data: {
        agents: { files: [{ action: "created", path: "AGENTS.md" }] },
        alreadyInitialized: false,
        configPath: "inrepo.json",
        initialized: true,
      },
      ok: true,
      schemaVersion: 1,
    });
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(true);
    expect(await read("AGENTS.md")).toBe(`${renderAgentsBlock()}\n`);
    expect(existsSync(nodePath.join(cwd, "CLAUDE.md"))).toBe(false);
  });

  test("plain init reports agents as null", async () => {
    const r = await runCli(["init", "--json"], { cwd, env: INIT_ENV });
    expect(r.exitCode).toBe(0);
    expect(envelope(r).data).toEqual({
      agents: null,
      alreadyInitialized: false,
      configPath: "inrepo.json",
      initialized: true,
    });
    expect(existsSync(nodePath.join(cwd, "AGENTS.md"))).toBe(false);

    const again = await runCli(["init", "--json"], { cwd, env: INIT_ENV });
    expect(envelope(again).data).toMatchObject({
      alreadyInitialized: true,
      initialized: false,
    });
  });

  test("appends to an existing AGENTS.md and replaces the block on rerun", async () => {
    await writeFile(
      nodePath.join(cwd, "AGENTS.md"),
      "# Project rules\n\nUse tabs.\n",
      "utf-8"
    );
    const first = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(first.exitCode).toBe(0);
    expect(envelope(first).data?.agents).toEqual({
      files: [{ action: "updated", path: "AGENTS.md" }],
    });
    const content = await read("AGENTS.md");
    expect(content).toBe(
      `# Project rules\n\nUse tabs.\n\n${renderAgentsBlock()}\n`
    );

    // Idempotent: a second run leaves the file byte-identical.
    const second = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(second.exitCode).toBe(0);
    expect(envelope(second).data).toMatchObject({
      agents: { files: [{ action: "unchanged", path: "AGENTS.md" }] },
      alreadyInitialized: true,
      initialized: false,
    });
    expect(await read("AGENTS.md")).toBe(content);

    // A stale block is replaced in place; surrounding text is kept.
    await writeFile(
      nodePath.join(cwd, "AGENTS.md"),
      `# Project rules\n\n${AGENTS_BLOCK_START}\nold guidance\n${AGENTS_BLOCK_END}\n\n## Later section\n`,
      "utf-8"
    );
    const third = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(envelope(third).data?.agents).toEqual({
      files: [{ action: "updated", path: "AGENTS.md" }],
    });
    const replaced = await read("AGENTS.md");
    expect(replaced).toBe(
      `# Project rules\n\n${renderAgentsBlock()}\n\n## Later section\n`
    );
    expect(countOf(replaced, AGENTS_BLOCK_START)).toBe(1);
  });

  test("adds the block to a CLAUDE.md that does not reference AGENTS.md", async () => {
    await writeFile(nodePath.join(cwd, "CLAUDE.md"), "# Claude\n", "utf-8");
    const r = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(r.exitCode).toBe(0);
    expect(envelope(r).data?.agents).toEqual({
      files: [
        { action: "created", path: "AGENTS.md" },
        { action: "updated", path: "CLAUDE.md" },
      ],
    });
    expect(await read("CLAUDE.md")).toBe(
      `# Claude\n\n${renderAgentsBlock()}\n`
    );

    // The block mentions AGENTS.md itself; that must not stop later updates.
    const again = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(envelope(again).data?.agents).toEqual({
      files: [
        { action: "unchanged", path: "AGENTS.md" },
        { action: "unchanged", path: "CLAUDE.md" },
      ],
    });
  });

  test("leaves a CLAUDE.md that already defers to AGENTS.md alone", async () => {
    await writeFile(nodePath.join(cwd, "CLAUDE.md"), "@AGENTS.md\n", "utf-8");
    const r = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(envelope(r).data?.agents).toEqual({
      files: [{ action: "created", path: "AGENTS.md" }],
    });
    expect(await read("CLAUDE.md")).toBe("@AGENTS.md\n");
  });

  test("writes a CLAUDE.md symlinked to AGENTS.md only once", async () => {
    await writeFile(nodePath.join(cwd, "AGENTS.md"), "# Rules\n", "utf-8");
    await symlink("AGENTS.md", nodePath.join(cwd, "CLAUDE.md"));
    const r = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(envelope(r).data?.agents).toEqual({
      files: [{ action: "updated", path: "AGENTS.md" }],
    });
    expect(countOf(await read("AGENTS.md"), AGENTS_BLOCK_START)).toBe(1);
  });

  test("without INREPO_CONFIG, --agents fails like init and writes nothing", async () => {
    const r = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: { INREPO_NONINTERACTIVE: "1" },
    });
    expect(r.exitCode).toBe(2);
    expect(envelope(r).error?.code).toBe("CONFIG_NOT_FOUND");
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(false);
    expect(existsSync(nodePath.join(cwd, "AGENTS.md"))).toBe(false);
  });

  test("an unmatched marker is reported instead of guessed at", async () => {
    await writeFile(
      nodePath.join(cwd, "AGENTS.md"),
      `# Rules\n\n${AGENTS_BLOCK_START}\nhalf a block\n`,
      "utf-8"
    );
    const r = await runCli(["init", "--agents", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(envelope(r).error?.code).toBe("ERROR");
    expect(envelope(r).error?.message).toMatch(/unmatched inrepo marker/u);
  });

  test("an unknown option is a usage error (exit 2)", async () => {
    const r = await runCli(["init", "--agent", "--json"], {
      cwd,
      env: INIT_ENV,
    });
    expect(r.exitCode).toBe(2);
    const env = envelope(r);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("USAGE");
    expect(env.error?.message).toBe("Unknown option: --agent");
    expect(existsSync(nodePath.join(cwd, "inrepo.json"))).toBe(false);
    expect(existsSync(nodePath.join(cwd, "AGENTS.md"))).toBe(false);
  });

  test("--help lists status, init --agents, the global flags, and exit codes", async () => {
    const r = await runCli(["--help"], { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/inrepo status \[<name>\]/u);
    expect(r.stdout).toMatch(/inrepo init \[--agents\]/u);
    expect(r.stdout).toMatch(/--json/u);
    expect(r.stdout).toMatch(/--dry-run/u);
    expect(r.stdout).toMatch(/Exit codes \(with --json; without it every failure exits 1\):/u);
    expect(r.stdout).toMatch(/3 needs resolution/u);
  });

  test("a positional argument keeps the existing usage message", async () => {
    const r = await runCli(["init", "--agents", "extra"], {
      cwd,
      env: INIT_ENV,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/init does not take arguments/u);
  });
});
