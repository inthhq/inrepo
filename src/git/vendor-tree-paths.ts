import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** All file and directory paths under `absRoot`, relative with POSIX `/` (not including empty root). */
export async function listRelativePathsRecursive(absRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(absDir: string, relPosix: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const ent of entries) {
      const childRel = relPosix ? `${relPosix}/${ent.name}` : ent.name;
      out.push(childRel);
      if (ent.isDirectory()) {
        await walk(join(absDir, ent.name), childRel);
      }
    }
  }
  await walk(absRoot, '');
  return out;
}

export function pathDepth(relPosix: string): number {
  return relPosix.split('/').length;
}
