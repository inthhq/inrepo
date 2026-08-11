import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree } from '../overlay/tree-utils.js';
import {
  hasStagedChanges,
  initSeriesBaseRepo,
  replaceWorkTree,
  runSeriesGit,
  skipGitDir,
  stageAll,
  type SeriesAuthor,
} from './series-git.js';

export type FormattedSeriesPatch = {
  /** File name git chose, e.g. `0002-tighten-jsdoc-types.patch`. */
  fileName: string;
  /** Raw `git format-patch --binary` bytes, ready to write into `series/`. */
  content: Buffer;
};

/**
 * Produce one `git format-patch --binary` patch describing
 * `baseRoot -> patchedRoot`.
 *
 * Both trees are staged in a throwaway repository, so the patch carries exact
 * hunks, binary literals, deletions, symlinks, and mode changes.
 */
export async function formatSeriesPatch(opts: {
  baseRoot: string;
  patchedRoot: string;
  subject: string;
  author?: SeriesAuthor;
  /** Number used for the `NNNN-` filename prefix (default 1). */
  startNumber?: number;
}): Promise<FormattedSeriesPatch> {
  const work = await mkdtemp(join(tmpdir(), 'inrepo-series-format-'));
  const repo = join(work, 'repo');
  const out = join(work, 'out');

  try {
    await copyTree(opts.baseRoot, repo, { skip: skipGitDir, treatMissingAsEmpty: true });
    await initSeriesBaseRepo(repo);

    await replaceWorkTree(repo, opts.patchedRoot);
    await stageAll(repo);
    if (!(await hasStagedChanges(repo))) {
      throw new Error('No differences between the upstream tree and the patched tree');
    }
    await runSeriesGit(
      ['commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', opts.subject],
      { cwd: repo, author: opts.author },
    );

    await runSeriesGit(
      [
        'format-patch',
        '--binary',
        '--full-index',
        '--no-signature',
        '--no-numbered',
        '--start-number',
        String(opts.startNumber ?? 1),
        '-o',
        out,
        '-1',
        'HEAD',
      ],
      { cwd: repo, author: opts.author },
    );

    const produced = (await readdir(out)).filter((name) => name.endsWith('.patch')).sort();
    if (produced.length !== 1) {
      throw new Error(`Expected exactly one patch file from git format-patch, got ${produced.length}`);
    }

    return {
      fileName: produced[0],
      content: await readFile(join(out, produced[0])),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
