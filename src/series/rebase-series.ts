import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree, defaultSkipTreePath } from '../overlay/tree-utils.js';
import { applySeriesToRepo } from './apply-series.js';
import { readSeries, seriesPatchFileName, type SeriesPatch } from './read-series.js';
import {
  initSeriesBaseRepo,
  replaceWorkTree,
  runSeriesGit,
  runSeriesGitCapture,
  skipGitDir,
  stageAll,
  trySeriesGit,
  SERIES_BASE_BRANCH,
  type SeriesAuthor,
} from './series-git.js';

/** Branch holding the new upstream pin inside an update scratch repository. */
export const SERIES_TARGET_BRANCH = 'inrepo-new-upstream';

/** One patch of a successfully rebased series, ready to be written to disk. */
export type RebasedPatch = {
  /** Position in the rebased series, 1-based; also the `NNNN-` prefix. */
  number: number;
  subject: string;
  fileName: string;
  content: Buffer;
};

export type SeriesRebaseResult =
  | { status: 'rebased'; patches: RebasedPatch[] }
  | {
      status: 'conflict';
      /** 1-based position of the patch the rebase stopped on. */
      number: number;
      subject: string;
      /** Paths in the scratch work tree that carry conflict markers. */
      files: string[];
    };

function updateSkip(relPosix: string): boolean {
  return skipGitDir(relPosix) || defaultSkipTreePath(relPosix);
}

/** True while git has a rebase parked in the scratch repository. */
export function rebaseInProgress(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, '.git', 'rebase-merge')) ||
    existsSync(join(repoRoot, '.git', 'rebase-apply'))
  );
}

async function conflictedFiles(repoRoot: string): Promise<string[]> {
  const raw = await runSeriesGitCapture(['diff', '--name-only', '--diff-filter=U'], {
    cwd: repoRoot,
  });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Subject of the patch git is currently stuck on. */
async function stoppedSubject(repoRoot: string): Promise<string> {
  try {
    return await runSeriesGitCapture(['log', '-1', '--format=%s', 'REBASE_HEAD'], {
      cwd: repoRoot,
    });
  } catch {
    const messagePath = join(repoRoot, '.git', 'rebase-merge', 'message');
    if (!existsSync(messagePath)) return '(unknown patch)';
    return (await readFile(messagePath, 'utf8')).split('\n')[0].trim() || '(unknown patch)';
  }
}

async function commitCount(repoRoot: string, range: string): Promise<number> {
  const raw = await runSeriesGitCapture(['rev-list', '--count', range], { cwd: repoRoot });
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function conflictResult(repoRoot: string, newBase: string): Promise<SeriesRebaseResult> {
  return {
    status: 'conflict',
    number: (await commitCount(repoRoot, `${newBase}..HEAD`)) + 1,
    subject: await stoppedSubject(repoRoot),
    files: await conflictedFiles(repoRoot),
  };
}

/**
 * Regenerate the series from the commits that now sit on top of the new
 * upstream base. `git format-patch` renumbers them from 0001 and carries each
 * commit's original author, date, and subject into the new file.
 */
async function collectRebasedPatches(
  repoRoot: string,
  newBase: string,
): Promise<RebasedPatch[]> {
  const out = await mkdtemp(join(tmpdir(), 'inrepo-rebase-out-'));
  try {
    const range = `${newBase}..HEAD`;
    await runSeriesGit(
      [
        'format-patch',
        '--binary',
        '--full-index',
        '--no-signature',
        '--no-numbered',
        '--start-number',
        '1',
        '-o',
        out,
        range,
      ],
      { cwd: repoRoot },
    );

    const produced = (await readdir(out)).filter((name) => name.endsWith('.patch')).sort();
    // `<sha>\t<subject>` keeps one line per commit even when a subject is
    // empty, which a hand-written patch file is allowed to be.
    const subjectLines = await runSeriesGitCapture(
      ['log', '--reverse', '--format=%H%x09%s', range],
      { cwd: repoRoot, trim: false },
    );
    const subjects = subjectLines
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.slice(line.indexOf('\t') + 1));
    if (subjects.length !== produced.length) {
      throw new Error(
        `Expected ${subjects.length} patch file(s) from git format-patch, got ${produced.length}`,
      );
    }

    const patches: RebasedPatch[] = [];
    for (let i = 0; i < produced.length; i += 1) {
      patches.push({
        number: i + 1,
        subject: subjects[i],
        fileName: seriesPatchFileName(produced[i], i + 1),
        content: await readFile(join(out, produced[i])),
      });
    }
    return patches;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/**
 * Start rebasing a package's committed patch series onto a newer upstream
 * commit.
 *
 * The scratch repository gets the old pin as its base commit, the existing
 * series applied on top of it as one commit per patch, and a sibling commit
 * carrying the new pin. `git rebase --onto` then replays the patch commits onto
 * the new pin, which is what produces ordinary git conflict markers when
 * upstream and a patch touch the same lines.
 *
 * `resolveNewRoot` is called only after the old upstream tree has been copied
 * into the scratch repository, so both trees may be the same cache directory.
 */
export async function startSeriesRebase(opts: {
  repoRoot: string;
  seriesDir: string;
  /** Upstream tree at the currently pinned commit. */
  oldRoot: string;
  /** Materializes the upstream tree at the new commit and returns its root. */
  resolveNewRoot: () => Promise<string>;
  author?: SeriesAuthor;
  /** Called as each existing patch is replayed onto the old pin. */
  onPatch?: (patch: SeriesPatch) => void;
}): Promise<{ newBase: string; result: SeriesRebaseResult }> {
  const patches = await readSeries(opts.seriesDir);
  if (patches.length === 0) {
    throw new Error(`No patches found in ${opts.seriesDir}`);
  }

  const repo = opts.repoRoot;
  await rm(repo, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  await copyTree(opts.oldRoot, repo, { skip: updateSkip, treatMissingAsEmpty: true });
  await initSeriesBaseRepo(repo);
  const oldBase = await runSeriesGitCapture(['rev-parse', 'HEAD'], { cwd: repo });

  try {
    await applySeriesToRepo(repo, patches, { onPatch: opts.onPatch });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(
      `The committed series does not apply to the pinned commit, so there is nothing to rebase: ${err.message}`,
    );
  }

  const newRoot = await opts.resolveNewRoot();
  await runSeriesGit(['checkout', '--quiet', '-b', SERIES_TARGET_BRANCH, oldBase], { cwd: repo });
  await replaceWorkTree(repo, newRoot, { skip: updateSkip });
  await stageAll(repo);
  await runSeriesGit(
    ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'inrepo upstream update'],
    { cwd: repo, author: opts.author },
  );
  const newBase = await runSeriesGitCapture(['rev-parse', 'HEAD'], { cwd: repo });

  const result = await runRebaseStep(
    repo,
    ['rebase', '--onto', SERIES_TARGET_BRANCH, oldBase, SERIES_BASE_BRANCH],
    newBase,
    opts.author,
  );
  return { newBase, result };
}

/**
 * Resume a rebase the user has resolved by hand. Everything in the scratch work
 * tree is staged first, so resolving a conflict is just editing files. A
 * resolution that leaves the patch with no effect skips it, mirroring what git
 * asks for when `--continue` finds nothing to commit.
 */
export async function continueSeriesRebase(opts: {
  repoRoot: string;
  newBase: string;
  author?: SeriesAuthor;
}): Promise<SeriesRebaseResult> {
  const repo = opts.repoRoot;
  if (!rebaseInProgress(repo)) {
    // The rebase already finished (for example a previous --continue crashed
    // after git committed); regenerating from the range is still correct.
    return { status: 'rebased', patches: await collectRebasedPatches(repo, opts.newBase) };
  }

  await stageAll(repo);
  const patchIsEmpty = await trySeriesGit(['diff', '--cached', '--quiet'], { cwd: repo });
  const args = patchIsEmpty ? ['rebase', '--skip'] : ['rebase', '--continue'];
  return runRebaseStep(repo, args, opts.newBase, opts.author);
}

/**
 * Run one rebase command and translate its outcome: a stopped rebase is a
 * conflict to report, anything else is a real failure.
 */
async function runRebaseStep(
  repoRoot: string,
  args: string[],
  newBase: string,
  author?: SeriesAuthor,
): Promise<SeriesRebaseResult> {
  try {
    await runSeriesGit(args, { cwd: repoRoot, author });
  } catch (e) {
    if (!rebaseInProgress(repoRoot)) throw e;
    return conflictResult(repoRoot, newBase);
  }
  if (rebaseInProgress(repoRoot)) return conflictResult(repoRoot, newBase);
  return { status: 'rebased', patches: await collectRebasedPatches(repoRoot, newBase) };
}

/**
 * Replace a package's committed series with the rebased one. Called only once
 * the rebase has finished, so the committed patch files change exactly once per
 * successful update. An empty result removes the series directory, because a
 * package whose patches all became redundant no longer has any.
 */
export async function writeRebasedSeries(
  seriesDir: string,
  patches: RebasedPatch[],
): Promise<void> {
  await rm(seriesDir, { recursive: true, force: true });
  if (patches.length === 0) return;
  await mkdir(seriesDir, { recursive: true });
  for (const patch of patches) {
    await writeFile(join(seriesDir, patch.fileName), patch.content);
  }
}
