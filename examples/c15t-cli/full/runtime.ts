import { access, readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

export const FULL_DIR = import.meta.dir;
export const FIXTURE_DIR = join(FULL_DIR, 'vendor');
export const RUNTIME_PATH_FILE = join(FULL_DIR, '.runtime-path');

export async function runtimeDir(): Promise<string> {
  const value = (await readFile(RUNTIME_PATH_FILE, 'utf8')).trim();
  if (value === '') throw new Error(`Empty ${RUNTIME_PATH_FILE}; run npm run full:prepare`);
  return value;
}

export async function assertNoNodeModulesFallback(entry: string): Promise<void> {
  let cursor = dirname(entry);
  const root = parse(cursor).root;
  while (true) {
    try {
      await access(join(cursor, 'node_modules'));
      throw new Error(`Candidate could fall back to node_modules at ${join(cursor, 'node_modules')}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Candidate could')) throw error;
    }
    if (cursor === root) break;
    cursor = dirname(cursor);
  }
}
