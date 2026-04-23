import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { moduleStatePath } from './overlay-paths.js';

export type ModuleSyncState = {
  overlayHash: string;
  moduleHash: string;
};

function parseState(raw: string, path: string): ModuleSyncState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid module state in ${path}: ${err.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid module state in ${path}: expected an object`);
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.overlayHash !== 'string' || typeof rec.moduleHash !== 'string') {
    throw new Error(`Invalid module state in ${path}: missing required fields`);
  }
  return {
    overlayHash: rec.overlayHash,
    moduleHash: rec.moduleHash,
  };
}

export async function readModuleState(cwd: string, name: string): Promise<ModuleSyncState | null> {
  const path = moduleStatePath(cwd, name);
  if (!existsSync(path)) return null;
  return parseState(await readFile(path, 'utf8'), path);
}

export async function writeModuleState(
  cwd: string,
  name: string,
  state: ModuleSyncState,
): Promise<void> {
  const path = moduleStatePath(cwd, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
