import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type TreeKind = 'file' | 'dir' | 'symlink';

export type TreeEntry = {
  kind: TreeKind;
  executable: boolean;
  mode: number;
  size: number | null;
  linkTarget: string | null;
};

export const DEFAULT_IGNORED_BASENAMES = new Set([
  '.git',
  '.inrepo-vendor.json',
  '.pristine-meta.json',
]);

export function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

export function normalizedFileMode(mode: number): number {
  return isExecutableMode(mode) ? 0o755 : 0o644;
}

export function relPosixToAbs(root: string, relPosix: string): string {
  if (relPosix === '') return root;
  return join(root, ...relPosix.split('/'));
}

export function defaultSkipTreePath(relPosix: string): boolean {
  return relPosix.split('/').some((part) => DEFAULT_IGNORED_BASENAMES.has(part));
}

function kindFromStat(stat: Awaited<ReturnType<typeof lstat>>): TreeKind {
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  throw new Error(`Unsupported filesystem entry type (mode=${stat.mode})`);
}

export async function walkTree(
  root: string,
  opts: {
    skip?: (relPosix: string) => boolean;
    treatMissingAsEmpty?: boolean;
  } = {},
): Promise<Map<string, TreeEntry>> {
  if (!existsSync(root)) {
    if (opts.treatMissingAsEmpty === true) return new Map();
    throw new Error(`Directory does not exist: ${root}`);
  }

  const out = new Map<string, TreeEntry>();

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relPosix = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (opts.skip?.(relPosix) === true) continue;

      const abs = join(absDir, entry.name);
      const stat = await lstat(abs);
      const kind = kindFromStat(stat);
      const treeEntry: TreeEntry = {
        kind,
        executable: kind === 'file' ? isExecutableMode(stat.mode) : false,
        mode: stat.mode,
        size: kind === 'file' ? stat.size : null,
        linkTarget: kind === 'symlink' ? await readlink(abs) : null,
      };
      out.set(relPosix, treeEntry);

      if (kind === 'dir') {
        await walk(abs, relPosix);
      }
    }
  }

  await walk(root, '');
  return out;
}

export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(absPath);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

async function removeForReplacement(absPath: string, nextKind: TreeKind): Promise<void> {
  if (!existsSync(absPath)) return;
  const stat = await lstat(absPath);
  const currentKind = kindFromStat(stat);
  if (currentKind === 'dir' && nextKind === 'dir') return;
  await rm(absPath, { recursive: true, force: true });
}

function assertSymlinkWithinRoot(root: string, relPosix: string, target: string): void {
  if (isAbsolute(target)) {
    throw new Error(`Refusing to capture absolute symlink target at "${relPosix}"`);
  }
  const absDir = resolve(dirname(relPosixToAbs(root, relPosix)));
  const resolvedTarget = resolve(absDir, ...target.split(/[\\/]+/));
  const rel = relative(root, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to capture symlink escaping module root at "${relPosix}"`);
  }
}

export async function copyEntry(
  sourceRoot: string,
  relPosix: string,
  targetRoot: string,
  opts: {
    validateSymlinkWithinRoot?: boolean;
  } = {},
): Promise<void> {
  const sourceAbs = relPosixToAbs(sourceRoot, relPosix);
  const stat = await lstat(sourceAbs);
  const kind = kindFromStat(stat);
  const targetAbs = relPosixToAbs(targetRoot, relPosix);

  if (kind === 'dir') {
    await removeForReplacement(targetAbs, 'dir');
    await mkdir(targetAbs, { recursive: true });
    await chmod(targetAbs, 0o755);
    return;
  }

  await mkdir(dirname(targetAbs), { recursive: true });
  if (kind === 'file') {
    await removeForReplacement(targetAbs, 'file');
    await copyFile(sourceAbs, targetAbs);
    await chmod(targetAbs, normalizedFileMode(stat.mode));
    return;
  }

  const target = await readlink(sourceAbs);
  if (opts.validateSymlinkWithinRoot === true) {
    assertSymlinkWithinRoot(sourceRoot, relPosix, target);
  }
  await removeForReplacement(targetAbs, 'symlink');
  await symlink(target, targetAbs);
}

export async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  opts: {
    skip?: (relPosix: string) => boolean;
    treatMissingAsEmpty?: boolean;
    validateSymlinkWithinRoot?: boolean;
  } = {},
): Promise<void> {
  const entries = await walkTree(sourceRoot, {
    skip: opts.skip,
    treatMissingAsEmpty: opts.treatMissingAsEmpty,
  });
  await mkdir(targetRoot, { recursive: true });
  for (const relPosix of [...entries.keys()].sort()) {
    await copyEntry(sourceRoot, relPosix, targetRoot, {
      validateSymlinkWithinRoot: opts.validateSymlinkWithinRoot,
    });
  }
}
