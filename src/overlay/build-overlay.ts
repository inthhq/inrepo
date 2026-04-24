import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareTrees, type CompareTreesResult } from './compare-trees.js';
import { writeDeletionsFile } from './deletions-file.js';
import { copyEntry, walkTree } from './tree-utils.js';

function pathDepth(relPosix: string): number {
  return relPosix.split('/').length;
}

function isWithinDir(relPosix: string, dirPosix: string): boolean {
  return relPosix === dirPosix || relPosix.startsWith(`${dirPosix}/`);
}

function shouldIgnoreRemovedPath(relPosix: string, typeChanges: Set<string>): boolean {
  return [...typeChanges].some((changed) => relPosix.startsWith(`${changed}/`));
}

async function collapseDeletions(
  pristineRoot: string,
  compare: CompareTreesResult,
): Promise<string[]> {
  const pristineEntries = await walkTree(pristineRoot, { treatMissingAsEmpty: true });
  const removedSet = new Set(compare.removed);
  const typeChanges = new Set(compare.typeChanges);
  const collapsed: string[] = [];

  for (const relPosix of compare.removed.slice().sort((a, b) => pathDepth(a) - pathDepth(b))) {
    if (shouldIgnoreRemovedPath(relPosix, typeChanges)) continue;
    if (collapsed.some((entry) => entry.endsWith('/') && isWithinDir(relPosix, entry.slice(0, -1)))) {
      continue;
    }

    const entry = pristineEntries.get(relPosix);
    if (!entry) continue;
    if (entry.kind !== 'dir') {
      collapsed.push(relPosix);
      continue;
    }

    const subtree = [...pristineEntries.keys()].filter(
      (candidate) => candidate === relPosix || candidate.startsWith(`${relPosix}/`),
    );
    if (subtree.every((candidate) => removedSet.has(candidate))) {
      collapsed.push(`${relPosix}/`);
    } else {
      collapsed.push(relPosix);
    }
  }

  return [...new Set(collapsed)].sort();
}

export async function buildOverlay(opts: {
  pristineRoot: string;
  moduleRoot: string;
  overlayRoot: string;
}): Promise<{ compare: CompareTreesResult; deletions: string[] }> {
  const compare = await compareTrees(opts.pristineRoot, opts.moduleRoot);
  const moduleEntries = await walkTree(opts.moduleRoot, { treatMissingAsEmpty: true });
  const deletions = await collapseDeletions(opts.pristineRoot, compare);
  const stageParent = dirname(opts.overlayRoot);
  await mkdir(stageParent, { recursive: true });
  const stageRoot = await mkdtemp(join(stageParent, '.inrepo-overlay-'));

  try {
    const overlayPaths = [...new Set([...compare.added, ...compare.modified, ...compare.typeChanges])].sort();
    for (const relPosix of overlayPaths) {
      if (!moduleEntries.has(relPosix)) continue;
      await copyEntry(opts.moduleRoot, relPosix, stageRoot, {
        validateSymlinkWithinRoot: true,
      });
    }
    await writeDeletionsFile(join(stageRoot, '.inrepo-deletions'), deletions);

    const stagedEntries = await walkTree(stageRoot, { treatMissingAsEmpty: true });
    await rm(opts.overlayRoot, { recursive: true, force: true });
    if (stagedEntries.size === 0) {
      await rm(stageRoot, { recursive: true, force: true });
      return { compare, deletions };
    }
    await rename(stageRoot, opts.overlayRoot);

    return { compare, deletions };
  } finally {
    if (existsSync(stageRoot)) {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }
}
