import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { resolveGitUrlFromNpm } from './resolve-git-url-from-npm.js';

function mockFetchOnce(
  responses: Array<{ status?: number; body: unknown }>,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  let i = 0;
  const fake = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    const status = r.status ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(r.body ?? null), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  globalThis.fetch = fake as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('resolveGitUrlFromNpm', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = null;
  });

  afterEach(() => {
    restore?.();
  });

  test('returns normalized https URL from a string repository', async () => {
    const m = mockFetchOnce([
      {
        body: { repository: 'git+https://github.com/foo/bar.git' },
      },
    ]);
    restore = m.restore;
    const url = await resolveGitUrlFromNpm('bar');
    expect(url).toBe('https://github.com/foo/bar.git');
    expect(m.calls[0]).toBe('https://registry.npmjs.org/bar');
  });

  test('returns normalized URL from an object repository', async () => {
    const m = mockFetchOnce([
      { body: { repository: { type: 'git', url: 'https://github.com/foo/bar' } } },
    ]);
    restore = m.restore;
    expect(await resolveGitUrlFromNpm('bar')).toBe('https://github.com/foo/bar.git');
  });

  test('falls back to dist-tags.latest version repository', async () => {
    const m = mockFetchOnce([
      {
        body: {
          'dist-tags': { latest: '1.2.3' },
          versions: { '1.2.3': { repository: 'git@github.com:foo/bar.git' } },
        },
      },
    ]);
    restore = m.restore;
    expect(await resolveGitUrlFromNpm('bar')).toBe('https://github.com/foo/bar.git');
  });

  test('encodes scoped names in the URL', async () => {
    const m = mockFetchOnce([
      { body: { repository: 'https://github.com/clack/clack' } },
    ]);
    restore = m.restore;
    await resolveGitUrlFromNpm('@clack/prompts');
    expect(m.calls[0]).toBe('https://registry.npmjs.org/%40clack%2Fprompts');
  });

  test('throws on 404 with the package name in the message', async () => {
    const m = mockFetchOnce([{ status: 404, body: { error: 'Not found' } }]);
    restore = m.restore;
    await expect(resolveGitUrlFromNpm('does-not-exist')).rejects.toThrow(
      /package not found: does-not-exist/,
    );
  });

  test('throws on other HTTP errors', async () => {
    const m = mockFetchOnce([{ status: 500, body: 'oops' }]);
    restore = m.restore;
    await expect(resolveGitUrlFromNpm('bar')).rejects.toThrow(/HTTP 500 for bar/);
  });

  test('throws when there is no repository field anywhere', async () => {
    const m = mockFetchOnce([{ body: { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } } }]);
    restore = m.restore;
    await expect(resolveGitUrlFromNpm('bar')).rejects.toThrow(
      /No "repository" field for "bar"/,
    );
  });

  test('throws when repository URL cannot be normalized to GitHub', async () => {
    const m = mockFetchOnce([{ body: { repository: 'https://gitlab.com/foo/bar.git' } }]);
    restore = m.restore;
    await expect(resolveGitUrlFromNpm('bar')).rejects.toThrow(/Could not normalize repository URL/);
  });
});
