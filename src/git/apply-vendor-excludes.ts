import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { listRelativePathsRecursive, pathDepth } from './vendor-tree-paths.js';

/**
 * Parse `/body/flags` style entries (flags optional, a–z only).
 * Returns null if the string is not meant to be a regex literal.
 */
function tryParseSlashDelimitedRegex(trimmed: string): RegExp | null {
  if (!trimmed.startsWith('/') || trimmed.length < 3) return null;
  const last = trimmed.lastIndexOf('/');
  if (last <= 0) return null;
  const body = trimmed.slice(1, last);
  const flags = trimmed.slice(last + 1);
  if (flags && !/^[a-z]*$/.test(flags)) return null;
  if (!body) return null;
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

function assertSafeUnderDest(destRoot: string, relPosix: string): string {
  const abs = resolve(destRoot, ...relPosix.split('/'));
  const rel = relative(destRoot, abs);
  if (rel === '') {
    throw new Error(`Refusing to exclude the entire vendor directory: ${JSON.stringify(relPosix)}`);
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsafe exclude path (outside vendor dir): ${JSON.stringify(relPosix)}`);
  }
  return abs;
}

/**
 * Remove paths under `dest` (typically after `git clone`).
 *
 * - **Literal** entries: relative POSIX-style paths (no leading `/`), same as before.
 * - **Regex** entries: slash-delimited `/pattern/optionalflags` (e.g. `/^\\.git$/`).
 *   Patterns are tested against paths relative to the module root using `/` separators.
 */
export async function applyVendorExcludes(dest: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;

  let destRoot: string;
  try {
    destRoot = await realpath(dest);
  } catch {
    throw new Error(`Cannot resolve vendor directory for excludes: ${dest}`);
  }

  const regexes: RegExp[] = [];
  const literals: string[] = [];

  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const parsedRe = tryParseSlashDelimitedRegex(trimmed);
    if (parsedRe) {
      regexes.push(parsedRe);
      continue;
    }

    if (trimmed.startsWith('/')) {
      throw new Error(
        `Invalid exclude regex (expected /pattern/ or /pattern/flags): ${JSON.stringify(raw)}`,
      );
    }

    if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      throw new Error(`Exclude path must be relative to the module root: ${JSON.stringify(raw)}`);
    }

    literals.push(trimmed.split(sep).join('/'));
  }

  const toRemove = new Set<string>();

  if (regexes.length > 0) {
    const allRel = await listRelativePathsRecursive(destRoot);
    for (const relPosix of allRel) {
      if (
        regexes.some((r) => {
          r.lastIndex = 0;
          return r.test(relPosix);
        })
      ) {
        toRemove.add(relPosix);
      }
    }
  }

  for (const lit of literals) {
    toRemove.add(lit);
  }

  const sorted = [...toRemove].sort((a, b) => pathDepth(b) - pathDepth(a));
  const seenAbs = new Set<string>();

  for (const relPosix of sorted) {
    const abs = assertSafeUnderDest(destRoot, relPosix);
    if (seenAbs.has(abs)) continue;
    seenAbs.add(abs);

    if (!existsSync(abs)) {
      // Literal excludes may target optional paths; regex may list parents already removed.
      continue;
    }
    await rm(abs, { recursive: true, force: true });
  }
}
