import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { copyEntry, copyTree, relPosixToAbs, walkTree } from './tree-utils.js';

function skipOverlayControlFile(relPosix: string): boolean {
  return relPosix === '.inrepo-deletions';
}

export async function applyOverlay(opts: {
  pristineRoot: string;
  overlayRoot: string;
  deletions: string[];
  targetRoot: string;
}): Promise<string> {
  await rm(opts.targetRoot, { recursive: true, force: true });
  await mkdir(opts.targetRoot, { recursive: true });

  await copyTree(opts.pristineRoot, opts.targetRoot, {
    treatMissingAsEmpty: true,
  });

  if (existsSync(opts.overlayRoot)) {
    const overlayEntries = await walkTree(opts.overlayRoot, {
      skip: skipOverlayControlFile,
      treatMissingAsEmpty: true,
    });
    for (const relPosix of [...overlayEntries.keys()].sort()) {
      await copyEntry(opts.overlayRoot, relPosix, opts.targetRoot, {
        validateSymlinkWithinRoot: true,
      });
    }
  }

  for (const relPosix of opts.deletions) {
    const body = relPosix.endsWith('/') ? relPosix.slice(0, -1) : relPosix;
    await rm(relPosixToAbs(opts.targetRoot, body), { recursive: true, force: true });
  }

  return opts.targetRoot;
}
