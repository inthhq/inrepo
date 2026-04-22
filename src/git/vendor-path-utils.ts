import { isAbsolute, relative, resolve } from 'node:path';

/** Resolve `relPosix` under `destRoot` and ensure it stays inside the vendor tree. */
export function assertSafeUnderDest(destRoot: string, relPosix: string): string {
  const abs = resolve(destRoot, ...relPosix.split('/'));
  const rel = relative(destRoot, abs);
  if (rel === '') {
    throw new Error(`Refusing to use the entire vendor directory as a path: ${JSON.stringify(relPosix)}`);
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Unsafe path (outside vendor dir): ${JSON.stringify(relPosix)}`);
  }
  return abs;
}
