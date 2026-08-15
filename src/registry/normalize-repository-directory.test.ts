import { describe, expect, test } from 'bun:test';
import { normalizeRepositoryDirectory } from './normalize-repository-directory.js';

describe('normalizeRepositoryDirectory', () => {
  test('normalizes a package subdirectory', () => {
    expect(normalizeRepositoryDirectory('./packages/cli/')).toBe('packages/cli');
    expect(normalizeRepositoryDirectory('packages//cli')).toBe('packages/cli');
  });

  test('represents the repository root as null', () => {
    expect(normalizeRepositoryDirectory('.')).toBeNull();
    expect(normalizeRepositoryDirectory('./')).toBeNull();
  });

  test('rejects empty, absolute, traversal, Windows, and NUL paths', () => {
    expect(() => normalizeRepositoryDirectory('   ')).toThrow(/non-empty relative path/);
    expect(() => normalizeRepositoryDirectory('/packages/cli')).toThrow(/must be relative/);
    expect(() => normalizeRepositoryDirectory('C:\\packages\\cli')).toThrow(/POSIX/);
    expect(() => normalizeRepositoryDirectory('packages/../cli')).toThrow(/traversal/);
    expect(() => normalizeRepositoryDirectory('packages\0cli')).toThrow(/NUL/);
  });
});
