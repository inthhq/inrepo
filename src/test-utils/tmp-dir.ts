import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeTmpDir(prefix = 'inrepo-test-'): Promise<string> {
  const base = realpathSync(tmpdir());
  return mkdtemp(join(base, prefix));
}

export async function cleanupTmpDir(dir: string | undefined): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}
