import {
  defaultSkipTreePath,
  relPosixToAbs,
  sha256File,
  walkTree,
  type TreeKind,
} from '../overlay/tree-utils.js';

type TreeFingerprint = {
  kind: TreeKind;
  /** sha256 of the file bytes, the symlink target, or '' for a directory. */
  content: string;
  mode: '644' | '755' | null;
};

export type PatchedTreeComparison = {
  /** One line per byte-level difference in files or symlinks; empty means identical. */
  differences: string[];
  /**
   * Directories that exist in the left tree, are empty, and are absent from the
   * right tree. Git has no way to record an empty directory, so a patch series
   * cannot reproduce one; these are reported rather than treated as content
   * differences.
   */
  droppedEmptyDirectories: string[];
};

async function fingerprintTree(root: string): Promise<Map<string, TreeFingerprint>> {
  const entries = await walkTree(root, { skip: defaultSkipTreePath, treatMissingAsEmpty: true });
  const out = new Map<string, TreeFingerprint>();
  for (const [relPosix, entry] of entries) {
    if (entry.kind === 'dir') {
      out.set(relPosix, { kind: 'dir', content: '', mode: null });
      continue;
    }
    if (entry.kind === 'symlink') {
      out.set(relPosix, { kind: 'symlink', content: entry.linkTarget ?? '', mode: null });
      continue;
    }
    out.set(relPosix, {
      kind: 'file',
      content: await sha256File(relPosixToAbs(root, relPosix)),
      mode: entry.executable ? '755' : '644',
    });
  }
  return out;
}

function isEmptyDirectory(tree: Map<string, TreeFingerprint>, relPosix: string): boolean {
  for (const candidate of tree.keys()) {
    if (candidate.startsWith(`${relPosix}/`)) return false;
  }
  return true;
}

/**
 * Compare two patched trees byte for byte, including executable bits and
 * symlink targets. Directories only matter when they are empty, because every
 * other directory is implied by the paths it contains.
 */
export async function comparePatchedTrees(
  leftRoot: string,
  rightRoot: string,
): Promise<PatchedTreeComparison> {
  const [left, right] = await Promise.all([fingerprintTree(leftRoot), fingerprintTree(rightRoot)]);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences: string[] = [];
  const droppedEmptyDirectories: string[] = [];

  for (const relPosix of paths) {
    const a = left.get(relPosix);
    const b = right.get(relPosix);

    if (!a || !b) {
      const present = a ?? b;
      if (present == null) continue;
      if (present.kind === 'dir') {
        // Non-empty directories are already described by their contents.
        if (a && isEmptyDirectory(left, relPosix)) droppedEmptyDirectories.push(relPosix);
        else if (b && isEmptyDirectory(right, relPosix)) {
          differences.push(`unexpected empty directory: ${relPosix}`);
        }
        continue;
      }
      differences.push(`${a ? 'missing' : 'unexpected'}: ${relPosix}`);
      continue;
    }

    if (a.kind !== b.kind) {
      differences.push(`type changed: ${relPosix} (${a.kind} -> ${b.kind})`);
      continue;
    }
    if (a.kind === 'dir') continue;
    if (a.content !== b.content) {
      differences.push(
        a.kind === 'symlink' ? `symlink target changed: ${relPosix}` : `content changed: ${relPosix}`,
      );
      continue;
    }
    if (a.mode !== b.mode) {
      differences.push(`mode changed: ${relPosix} (${a.mode} -> ${b.mode})`);
    }
  }

  return { differences, droppedEmptyDirectories };
}
