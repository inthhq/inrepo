import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashTree } from '../../src/overlay/tree-hash.js';

const CLI_PATH = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');
const EXPECTED_TREE_HASHES = {
  commander: '4410fd3e35dd392c2eb42d40c5b60c93513ab64d506584344ad5edc7de42f8da',
  picocolors: '8af7b5d782630cb53ac606c5364872f382bafbb25d86b9fbbdfb5473b0a28c11',
} as const;

async function runCli(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      INREPO_NONINTERACTIVE: '1',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `inrepo ${args.join(' ')} failed with exit ${exitCode}\n${stdout}${stderr}`,
    );
  }
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'inrepo-scriptc-example-'));
  try {
    for (const entry of ['inrepo.json', 'inrepo.lock.json', 'package.json', 'inrepo_patches']) {
      await cp(join(import.meta.dir, entry), join(cwd, entry), { recursive: true });
    }

    await runCli(cwd, ['sync']);
    await runCli(cwd, ['verify']);

    for (const [name, expected] of Object.entries(EXPECTED_TREE_HASHES)) {
      const actual = await hashTree(join(cwd, 'inrepo_modules', name));
      if (actual !== expected) {
        throw new Error(
          `${name} generated tree hash changed: expected ${expected}, received ${actual}`,
        );
      }
    }

    console.log('scriptc example sync, verify, and generated tree hashes pass');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

await main();
