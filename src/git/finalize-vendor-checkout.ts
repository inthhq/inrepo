import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const VENDOR_MARKER = '.inrepo-vendor.json';

/**
 * Persist lock-compatible metadata and remove `.git` so `inrepo_modules` holds plain files only.
 */
export async function finalizeVendorCheckout(
  dest: string,
  meta: { commit: string; gitUrl: string },
): Promise<void> {
  await writeFile(
    join(dest, VENDOR_MARKER),
    `${JSON.stringify({ commit: meta.commit, gitUrl: meta.gitUrl }, null, 2)}\n`,
    'utf8',
  );
  const gitMeta = join(dest, '.git');
  if (existsSync(gitMeta)) {
    await rm(gitMeta, { recursive: true, force: true });
  }
}
