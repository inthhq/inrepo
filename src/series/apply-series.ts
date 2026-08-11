import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { copyTree, symlinkTargetEscapesRoot, walkTree } from '../overlay/tree-utils.js';
import { readSeries, type SeriesPatch } from './read-series.js';
import { initSeriesBaseRepo, runSeriesGit, skipGitDir } from './series-git.js';

/**
 * Reject symlinks the series introduced or rewrote that escape the module root.
 * Symlinks inherited unchanged from upstream are left alone, matching the
 * legacy overlay path.
 */
async function assertPatchedSymlinksWithinRoot(
  pristineRoot: string,
  targetRoot: string,
): Promise<void> {
  const [upstream, patched] = await Promise.all([
    walkTree(pristineRoot, { treatMissingAsEmpty: true }),
    walkTree(targetRoot, { treatMissingAsEmpty: true }),
  ]);

  for (const [relPosix, entry] of patched) {
    if (entry.kind !== 'symlink' || entry.linkTarget == null) continue;
    const before = upstream.get(relPosix);
    if (before?.kind === 'symlink' && before.linkTarget === entry.linkTarget) continue;
    if (isAbsolute(entry.linkTarget)) {
      throw new Error(`Refusing to apply absolute symlink target at "${relPosix}"`);
    }
    if (symlinkTargetEscapesRoot(targetRoot, relPosix, entry.linkTarget)) {
      throw new Error(`Refusing to apply symlink escaping module root at "${relPosix}"`);
    }
  }
}

async function abortInFlightApply(root: string): Promise<void> {
  try {
    await runSeriesGit(['am', '--abort'], { cwd: root });
  } catch {
    // The abort is best-effort cleanup; the original failure is what matters.
  }
}

/**
 * Rebuild the patched tree for a package: copy the pinned upstream checkout
 * into `targetRoot`, then apply every patch in the series with
 * `git am --3way` in filename order.
 *
 * The result is a plain directory (no `.git`), which is the "patched tree"
 * stage: upstream tree -> patched tree -> generated module.
 */
export async function applySeries(opts: {
  pristineRoot: string;
  seriesDir: string;
  targetRoot: string;
}): Promise<{ applied: SeriesPatch[] }> {
  const patches = await readSeries(opts.seriesDir);
  if (patches.length === 0) {
    throw new Error(`No patches found in ${opts.seriesDir}`);
  }

  await rm(opts.targetRoot, { recursive: true, force: true });
  await mkdir(opts.targetRoot, { recursive: true });
  await copyTree(opts.pristineRoot, opts.targetRoot, {
    skip: skipGitDir,
    treatMissingAsEmpty: true,
  });
  await initSeriesBaseRepo(opts.targetRoot);

  for (const patch of patches) {
    try {
      // --keep-cr: the mailbox splitter strips a trailing CR by default, which
      // would silently rewrite CRLF content.
      await runSeriesGit(['am', '--3way', '--keep-cr', '--no-verify', patch.path], {
        cwd: opts.targetRoot,
      });
    } catch (e) {
      await abortInFlightApply(opts.targetRoot);
      const err = e instanceof Error ? e : new Error(String(e));
      throw new Error(`Failed to apply ${patch.fileName}: ${err.message}`);
    }
  }

  await rm(join(opts.targetRoot, '.git'), { recursive: true, force: true });
  await assertPatchedSymlinksWithinRoot(opts.pristineRoot, opts.targetRoot);

  return { applied: patches };
}
