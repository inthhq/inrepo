import { describe, expect, test } from 'bun:test';
import { classifyDependencySpecifier } from './dependency-specifier.js';

describe('classifyDependencySpecifier', () => {
  test.each(['^1.0.0', '~2.3', '1.x', '*', '>=1 <2', '1.0.0 - 2.0.0', '^1 || ^2'])(
    'accepts the semver range %p',
    (range) => {
      expect(classifyDependencySpecifier(range)).toEqual({ supported: true, range });
    },
  );

  test('treats an empty specifier as *', () => {
    expect(classifyDependencySpecifier('  ')).toEqual({ supported: true, range: '*' });
  });

  test.each([
    ['workspace:^', /workspace protocol/],
    ['file:../local', /local path specifiers/],
    ['link:../local', /local path specifiers/],
    ['catalog:default', /catalog specifiers/],
    ['npm:other@^1.0.0', /npm alias specifiers/],
    ['git+https://github.com/o/r.git', /git specifiers/],
    ['github:owner/repo', /git host shorthand/],
    ['https://example.com/pkg.tgz', /tarball URL specifiers/],
    ['owner/repo#semver:^1', /git host shorthand/],
    ['latest', /not a semver range/],
    ['next', /not a semver range/],
  ])('rejects %p', (specifier, reason) => {
    const result = classifyDependencySpecifier(specifier);
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toMatch(reason);
  });
});
