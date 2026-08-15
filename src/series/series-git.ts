import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../git/run-git.js';
import { runGitCapture } from '../git/run-git-capture.js';
import { copyTree } from '../overlay/tree-utils.js';

/** Branch name used by the throwaway repositories that back the patch series engine. */
export const SERIES_BASE_BRANCH = 'inrepo-upstream';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export type SeriesAuthor = {
  name: string;
  email: string;
};

export const DEFAULT_SERIES_AUTHOR: SeriesAuthor = {
  name: 'inrepo',
  email: 'inrepo@localhost',
};

/**
 * Environment for scratch repositories: ignore the caller's global/system git
 * config (templates, clean filters, autocrlf) and any inherited repository
 * pointers so patch generation and application stay reproducible.
 */
function seriesGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
    'GIT_TEMPLATE_DIR',
  ]) {
    delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE;
  env.GIT_CONFIG_SYSTEM = NULL_DEVICE;
  env.GIT_TERMINAL_PROMPT = '0';
  // Nothing here is interactive: commands that would normally open an editor
  // (rebase --continue, commit) must reuse the existing message and exit.
  env.GIT_EDITOR = 'true';
  env.GIT_SEQUENCE_EDITOR = 'true';
  return env;
}

function seriesConfigArgs(author: SeriesAuthor): string[] {
  return [
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.safecrlf=false',
    '-c',
    'core.fileMode=true',
    '-c',
    'core.symlinks=true',
    '-c',
    'core.hooksPath=.git/inrepo-no-hooks',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    '-c',
    'diff.external=',
    '-c',
    'gc.auto=0',
    '-c',
    'core.editor=true',
    '-c',
    'sequence.editor=true',
    '-c',
    'rerere.enabled=false',
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
  ];
}

/** Run git inside a scratch series repository with hardened config and env. */
export function runSeriesGit(
  args: string[],
  opts: { cwd: string; author?: SeriesAuthor },
): Promise<void> {
  return runGit([...seriesConfigArgs(opts.author ?? DEFAULT_SERIES_AUTHOR), ...args], {
    cwd: opts.cwd,
    env: seriesGitEnv(),
  });
}

/** Same as {@link runSeriesGit} but returns stdout, trimmed unless told otherwise. */
export function runSeriesGitCapture(
  args: string[],
  opts: { cwd: string; author?: SeriesAuthor; trim?: boolean },
): Promise<string> {
  return runGitCapture([...seriesConfigArgs(opts.author ?? DEFAULT_SERIES_AUTHOR), ...args], {
    cwd: opts.cwd,
    env: seriesGitEnv(),
    trim: opts.trim,
  });
}

/**
 * Run a scratch-repo git command whose non-zero exit is a meaningful answer
 * rather than a failure, such as the `--quiet` diff predicates. Resolves `true`
 * when git exited 0.
 */
export async function trySeriesGit(
  args: string[],
  opts: { cwd: string; author?: SeriesAuthor },
): Promise<boolean> {
  try {
    await runSeriesGit(args, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a scratch repository in `root` and commit whatever is already
 * there as the upstream base commit.
 */
export async function initSeriesBaseRepo(root: string): Promise<void> {
  await runSeriesGit(['init', '-b', SERIES_BASE_BRANCH, '.'], { cwd: root });
  // Repository-level attributes win over any committed .gitattributes, so
  // upstream text/filter rules cannot rewrite bytes on the way in or out.
  await mkdir(join(root, '.git', 'info'), { recursive: true });
  await writeFile(join(root, '.git', 'info', 'attributes'), '* -text -filter\n', 'utf8');
  await stageAll(root);
  await runSeriesGit(['commit', '--quiet', '--no-verify', '-m', 'inrepo upstream base'], {
    cwd: root,
  });
}

/** Stage every path, including files an upstream .gitignore would exclude. */
export async function stageAll(root: string): Promise<void> {
  await runSeriesGit(['add', '--force', '--all', '.'], { cwd: root });
}

/** True when the work tree differs from HEAD. */
export async function hasStagedChanges(root: string): Promise<boolean> {
  const status = await runSeriesGitCapture(['status', '--porcelain'], { cwd: root });
  return status !== '';
}

/**
 * Replace the work tree (everything but `.git`) with the contents of
 * `sourceRoot`. `skip` additionally excludes paths the caller does not want the
 * scratch repository to see, such as generated markers.
 */
export async function replaceWorkTree(
  root: string,
  sourceRoot: string,
  opts: { skip?: (relPosix: string) => boolean } = {},
): Promise<void> {
  for (const entry of await readdir(root)) {
    if (entry === '.git') continue;
    await rm(join(root, entry), { recursive: true, force: true });
  }
  // The scratch repository lives in `root`, so a stray `.git` entry in the
  // source tree must never be copied over it.
  const extraSkip = opts.skip;
  await copyTree(sourceRoot, root, {
    skip: extraSkip ? (relPosix) => skipGitDir(relPosix) || extraSkip(relPosix) : skipGitDir,
    treatMissingAsEmpty: true,
  });
}

/** Skip predicate that keeps a source tree's `.git` out of a scratch repository. */
export function skipGitDir(relPosix: string): boolean {
  return relPosix === '.git' || relPosix.startsWith('.git/');
}
