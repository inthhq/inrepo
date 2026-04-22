import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { assertSafeUnderDest } from './vendor-path-utils.js';
import { listRelativePathsRecursive, pathDepth } from './vendor-tree-paths.js';

function normalizeKeepPrefixes(prefixes: string[]): string[] {
  return [...new Set(prefixes.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean))];
}

function isKept(relPosix: string, prefixes: string[]): boolean {
  for (const k of prefixes) {
    if (relPosix === k || relPosix.startsWith(`${k}/`)) return true;
  }
  return false;
}

/** Directory prefixes along rel (e.g. "a/b/c" -> ["a", "a/b"]). */
function ancestorDirectoryRels(relPosix: string): string[] {
  const parts = relPosix.split('/');
  if (parts.length <= 1) return [];
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
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

  const protectedRel = new Set<string>();
  for (const s of survivors) {
    protectedRel.add(s);
    for (const a of ancestorDirectoryRels(s)) {
      protectedRel.add(a);
    }
  }

  const toRemove = allRel.filter((r) => !isKept(r, normalized) && !protectedRel.has(r));
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
