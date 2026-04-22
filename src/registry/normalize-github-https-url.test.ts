import { describe, expect, test } from 'bun:test';
import { normalizeGithubHttpsUrl } from './normalize-github-https-url.js';

describe('normalizeGithubHttpsUrl', () => {
  test('strips git+ prefix', () => {
    expect(normalizeGithubHttpsUrl('git+https://github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar.git',
    );
  });

  test('handles ssh form git@github.com:foo/bar.git', () => {
    expect(normalizeGithubHttpsUrl('git@github.com:foo/bar.git')).toBe(
      'https://github.com/foo/bar.git',
    );
    expect(normalizeGithubHttpsUrl('git@github.com:foo/bar')).toBe(
      'https://github.com/foo/bar.git',
    );
  });

  test('handles ssh:// scheme', () => {
    expect(normalizeGithubHttpsUrl('ssh://git@github.com/foo/bar.git')).toBe(
      'https://github.com/foo/bar.git',
    );
  });

  test('handles github:foo/bar shorthand', () => {
    expect(normalizeGithubHttpsUrl('github:foo/bar')).toBe('https://github.com/foo/bar.git');
  });

  test('normalizes plain https github URL with extra path', () => {
    expect(
      normalizeGithubHttpsUrl('https://github.com/foo/bar/tree/main/sub'),
    ).toBe('https://github.com/foo/bar.git');
  });

  test('returns null for non-github hosts', () => {
    expect(normalizeGithubHttpsUrl('https://gitlab.com/foo/bar.git')).toBeNull();
  });

  test('returns null for empty / unparsable input', () => {
    expect(normalizeGithubHttpsUrl('')).toBeNull();
    expect(normalizeGithubHttpsUrl('not a url')).toBeNull();
  });
});
