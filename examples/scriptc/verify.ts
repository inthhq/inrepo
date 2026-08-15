import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { hashTree } from "../../src/overlay/tree-hash.js";

const CLI_PATH = nodePath.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const EXPECTED_TREE_HASHES = {
  commander: "4410fd3e35dd392c2eb42d40c5b60c93513ab64d506584344ad5edc7de42f8da",
  picocolors:
    "8af7b5d782630cb53ac606c5364872f382bafbb25d86b9fbbdfb5473b0a28c11",
} as const;

const runCommand = async function runCommand(
  cwd: string,
  command: string[],
  label: string
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      INREPO_NONINTERACTIVE: "1",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${exitCode}\n${stdout}${stderr}`
    );
  }
};

const main = async function main(): Promise<void> {
  const cwd = await mkdtemp(nodePath.join(tmpdir(), "inrepo-scriptc-example-"));
  try {
    for (const entry of [
      "inrepo.json",
      "inrepo.lock.json",
      "package.json",
      "package-lock.json",
      "inrepo_patches",
    ]) {
      await cp(
        nodePath.join(import.meta.dir, entry),
        nodePath.join(cwd, entry),
        {
          recursive: true,
        }
      );
    }

    await runCommand(
      cwd,
      [
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      "npm ci"
    );
    await runCommand(cwd, [process.execPath, CLI_PATH, "sync"], "inrepo sync");
    await runCommand(
      cwd,
      [process.execPath, CLI_PATH, "verify"],
      "inrepo verify"
    );

    for (const [name, expected] of Object.entries(EXPECTED_TREE_HASHES)) {
      const actual = await hashTree(nodePath.join(cwd, "inrepo_modules", name));
      if (actual !== expected) {
        throw new Error(
          `${name} generated tree hash changed: expected ${expected}, received ${actual}`
        );
      }
    }

    console.log(
      "scriptc example clean install, sync, verify, and generated tree hashes pass"
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
};

await main();
