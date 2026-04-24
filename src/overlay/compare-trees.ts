import { defaultSkipTreePath, relPosixToAbs, sha256File, walkTree, type TreeEntry } from './tree-utils.js';

export type CompareTreesResult = {
  added: string[];
  modified: string[];
  unchanged: string[];
  removed: string[];
  typeChanges: string[];
};

async function sameEntry(
  leftRoot: string,
  rightRoot: string,
  relPosix: string,
  left: TreeEntry,
  right: TreeEntry,
): Promise<boolean> {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'dir') return true;
  if (left.kind === 'symlink') return left.linkTarget === right.linkTarget;
  if (left.executable !== right.executable) return false;
  if (left.size !== right.size) return false;
  const [leftHash, rightHash] = await Promise.all([
    sha256File(relPosixToAbs(leftRoot, relPosix)),
    sha256File(relPosixToAbs(rightRoot, relPosix)),
  ]);
  return leftHash === rightHash;
}

export async function compareTrees(
  leftRoot: string,
  rightRoot: string,
  opts: {
    skip?: (relPosix: string) => boolean;
  } = {},
): Promise<CompareTreesResult> {
  const skip = (relPosix: string): boolean =>
    defaultSkipTreePath(relPosix) || opts.skip?.(relPosix) === true;

  const [leftEntries, rightEntries] = await Promise.all([
    walkTree(leftRoot, { skip, treatMissingAsEmpty: true }),
    walkTree(rightRoot, { skip, treatMissingAsEmpty: true }),
  ]);

  const allPaths = [...new Set([...leftEntries.keys(), ...rightEntries.keys()])].sort();
  const result: CompareTreesResult = {
    added: [],
    modified: [],
    unchanged: [],
    removed: [],
    typeChanges: [],
  };

  for (const relPosix of allPaths) {
    const left = leftEntries.get(relPosix);
    const right = rightEntries.get(relPosix);
    if (!left && right) {
      result.added.push(relPosix);
      continue;
    }
    if (left && !right) {
      result.removed.push(relPosix);
      continue;
    }
    if (!left || !right) continue;
    if (left.kind !== right.kind) {
      result.typeChanges.push(relPosix);
      continue;
    }
    if (await sameEntry(leftRoot, rightRoot, relPosix, left, right)) {
      result.unchanged.push(relPosix);
    } else {
      result.modified.push(relPosix);
    }
  }

  return result;
}
