import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SERIES_DIR_NAME } from '../overlay/overlay-paths.js';

/**
 * Top-level entries of `inrepo_patches/<package>/` that belong to the legacy
 * whole-file overlay (everything except the `series/` directory).
 */
export async function listLegacyOverlayEntries(overlayRoot: string): Promise<string[]> {
  if (!existsSync(overlayRoot)) return [];
  const entries = await readdir(overlayRoot, { withFileTypes: true });
  return entries
    .filter((entry) => !(entry.isDirectory() && entry.name === SERIES_DIR_NAME))
    .map((entry) => entry.name)
    .sort();
}

/** Remove the legacy overlay entries, keeping the `series/` directory intact. */
export async function removeLegacyOverlayEntries(overlayRoot: string): Promise<string[]> {
  const names = await listLegacyOverlayEntries(overlayRoot);
  for (const name of names) {
    await rm(join(overlayRoot, name), { recursive: true, force: true });
  }
  return names;
}
