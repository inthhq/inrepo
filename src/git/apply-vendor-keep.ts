import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { listRelativePathsRecursive, pathDepth } from './vendor-tree-paths.js';

function assertSafeUnderDest(destRoot: string, relPosix: string): string {
  const abs = resolve(destRoot, ...relPosix.split('/'));
  const rel = relative(destRoot, abs);
  if (rel === '') {
    throw new Error(`Refusing to remove the entire vendor directory: ${JSON.stringify(relPosix)}`);
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsafe path (outside vendor dir): ${JSON.stringify(relPosix)}`);
  }
  return abs;
}

function normalizeKeepPrefixes(prefixes: string[]): string[] {
  return [...new Set(prefixes.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean))];
}

function isKept(relPosix: string, prefixes: string[]): boolean {
  for (const k of prefixes) {
    if (relPosix === k || relPosix.startsWith(`${k}/`)) return true;
  }
  return false;
}

/**
 * Remove every path under `dest` that is not under one of the `keep` prefixes (equality or `prefix/`).
 * Runs before {@link applyVendorExcludes}. Prefixes use POSIX `/`.
 */
export async function applyVendorKeep(dest: string, prefixes: string[]): Promise<void> {
  const normalized = normalizeKeepPrefixes(prefixes);
  if (normalized.length === 0) return;

  let destRoot: string;
  try {
    destRoot = await realpath(dest);
  } catch {
    throw new Error(`Cannot resolve vendor directory for keep: ${dest}`);
  }

  const allRel = await listRelativePathsRecursive(destRoot);
  if (allRel.length === 0) return;

  const survivors = allRel.filter((r) => isKept(r, normalized));
  if (survivors.length === 0) {
    throw new Error(
      `keep allowlist matched no paths under the vendored module (prefixes: ${JSON.stringify(normalized)}).`,
    );
  }

  const toRemove = allRel.filter((r) => !isKept(r, normalized));
  const sorted = [...new Set(toRemove)].sort((a, b) => pathDepth(b) - pathDepth(a));
  const seenAbs = new Set<string>();

  for (const relPosix of sorted) {
    const abs = assertSafeUnderDest(destRoot, relPosix);
    if (seenAbs.has(abs)) continue;
    seenAbs.add(abs);
    if (!existsSync(abs)) continue;
    await rm(abs, { recursive: true, force: true });
  }
}
