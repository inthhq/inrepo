import { createHash } from 'node:crypto';
import { defaultSkipTreePath, relPosixToAbs, sha256File, walkTree } from './tree-utils.js';

export async function hashTree(
  root: string,
  opts: {
    skip?: (relPosix: string) => boolean;
  } = {},
): Promise<string> {
  const skip = (relPosix: string): boolean =>
    defaultSkipTreePath(relPosix) || opts.skip?.(relPosix) === true;
  const entries = await walkTree(root, { skip, treatMissingAsEmpty: true });
  const lines: string[] = [];

  for (const relPosix of [...entries.keys()].sort()) {
    const entry = entries.get(relPosix);
    if (!entry) continue;
    if (entry.kind === 'dir') {
      lines.push(`${relPosix}\tdir`);
    } else if (entry.kind === 'symlink') {
      lines.push(`${relPosix}\tsymlink\t${entry.linkTarget ?? ''}`);
    } else {
      const mode = entry.executable ? '755' : '644';
      const hash = await sha256File(relPosixToAbs(root, relPosix));
      lines.push(`${relPosix}\tfile\t${mode}\t${hash}`);
    }
  }

  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
