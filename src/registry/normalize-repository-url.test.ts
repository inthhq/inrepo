import { describe, expect, test } from 'bun:test';
import { normalizeRepositoryUrl } from './normalize-repository-url.js';

describe('normalizeRepositoryUrl', () => {
  test.each([
    ['git+https://github.com/foo/bar.git', 'https://github.com/foo/bar.git'],
    ['git@github.com:foo/bar.git', 'https://github.com/foo/bar.git'],
    ['github:foo/bar', 'https://github.com/foo/bar.git'],
  ])('normalizes the GitHub form %p', (raw, expected) => {
    expect(normalizeRepositoryUrl(raw)).toBe(expected);
  });

  test.each([
    'https://gitlab.com/foo/bar.git',
    'ssh://git@codeberg.org/foo/bar.git',
    'git@gitlab.com:foo/bar.git',
    '/srv/mirrors/bar.git',
  ])('passes through the clonable URL %p', (raw) => {
    expect(normalizeRepositoryUrl(raw)).toBe(raw);
  });

  test('strips a git+ prefix from a non-GitHub URL', () => {
    expect(normalizeRepositoryUrl('git+https://gitlab.com/foo/bar.git')).toBe(
      'https://gitlab.com/foo/bar.git',
    );
  });

  test.each(['', '   ', 'gist:abc123', 'foo/bar'])('rejects %p', (raw) => {
    expect(normalizeRepositoryUrl(raw)).toBeNull();
  });
});
