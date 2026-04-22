import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeUnderDest } from './vendor-path-utils.js';

describe('assertSafeUnderDest', () => {
  const root = resolve(tmpdir(), 'inrepo-safe-root');

  test('returns absolute path for normal relative entry', () => {
    expect(assertSafeUnderDest(root, 'a/b')).toBe(join(root, 'a', 'b'));
  });

  test('rejects empty (resolves to root itself)', () => {
    expect(() => assertSafeUnderDest(root, '')).toThrow(
      /Refusing to use the entire vendor directory/,
    );
  });

  test('rejects ".." escape', () => {
    expect(() => assertSafeUnderDest(root, '../escape')).toThrow(/Unsafe path/);
    expect(() => assertSafeUnderDest(root, 'a/../../b')).toThrow(/Unsafe path/);
  });
});
