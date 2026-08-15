import { describe, expect, test } from 'bun:test';
import { isValidRange, maxSatisfyingAll, satisfies } from './range.js';

describe('satisfies', () => {
  test.each([
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['1.0.0', '^1.0.0', true],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false],
    ['0.0.4', '^0.0.3', false],
    ['0.0.3', '^0.0.3', true],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.9.9', '~1', true],
    ['2.0.0', '~1', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.4', '1.2', true],
    ['1.3.0', '1.2', false],
    ['1.9.0', '1', true],
    ['1.9.0', '1.x', true],
    ['1.9.0', '*', true],
    ['1.9.0', '', true],
    ['1.5.0', '>=1.2.3 <2.0.0', true],
    ['2.0.0', '>=1.2.3 <2.0.0', false],
    ['1.5.0', '>= 1.2.3 < 2.0.0', true],
    ['1.3.0', '>1.2', true],
    ['1.2.9', '>1.2', false],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['2.5.0', '1.0.0 - 3.0.0', true],
    ['3.0.1', '1.0.0 - 3.0.0', false],
    ['2.3.9', '1.2 - 2.3', true],
    ['2.4.0', '1.2 - 2.3', false],
    ['1.0.0', '^1.0.0 || ^3.0.0', true],
    ['3.5.0', '^1.0.0 || ^3.0.0', true],
    ['2.0.0', '^1.0.0 || ^3.0.0', false],
  ])('%s satisfies %p → %p', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test('prereleases are excluded unless the range names one', () => {
    expect(satisfies('2.0.0-rc.1', '^1.0.0 || >=1.0.0')).toBe(false);
    expect(satisfies('1.0.0-rc.1', '^1.0.0')).toBe(false);
    expect(satisfies('1.0.0-rc.1', '>=1.0.0-rc.1')).toBe(true);
    expect(satisfies('1.0.0-rc.2', '>=1.0.0-rc.1 <2.0.0')).toBe(true);
    expect(satisfies('1.2.0-rc.1', '>=1.0.0-rc.1 <2.0.0')).toBe(false);
  });

  test('invalid input never satisfies', () => {
    expect(satisfies('not-a-version', '^1.0.0')).toBe(false);
    expect(satisfies('1.0.0', 'workspace:^')).toBe(false);
  });
});

describe('isValidRange', () => {
  test.each(['^1.0.0', '~1.2', '1.x', '*', '', '>=1 <2', '1.0.0 - 2.0.0', '1 || 2'])(
    'accepts %p',
    (range) => {
      expect(isValidRange(range)).toBe(true);
    },
  );

  test.each(['workspace:^', 'file:../x', 'npm:other@^1', 'latest', '1.x.3'])(
    'rejects %p',
    (range) => {
      expect(isValidRange(range)).toBe(false);
    },
  );
});

describe('maxSatisfyingAll', () => {
  const versions = ['1.0.0', '1.2.0', '1.4.1', '2.0.0', '2.1.0', '3.0.0-rc.1'];

  test('picks the highest version matching a single range', () => {
    expect(maxSatisfyingAll(versions, ['^1.0.0'])).toBe('1.4.1');
  });

  test('unifies overlapping ranges into one version', () => {
    expect(maxSatisfyingAll(versions, ['>=1.0.0', '<1.3.0'])).toBe('1.2.0');
  });

  test('returns null when ranges do not overlap on any published version', () => {
    expect(maxSatisfyingAll(versions, ['^1.0.0', '^2.0.0'])).toBeNull();
  });

  test('skips prereleases unless a range asks for them', () => {
    expect(maxSatisfyingAll(versions, ['>=2.0.0'])).toBe('2.1.0');
    expect(maxSatisfyingAll(versions, ['>=3.0.0-rc.1'])).toBe('3.0.0-rc.1');
  });

  test('ignores unparseable published versions', () => {
    expect(maxSatisfyingAll(['1.0.0', 'garbage'], ['*'])).toBe('1.0.0');
  });

  test('returns null when a range is not valid semver', () => {
    expect(maxSatisfyingAll(versions, ['workspace:*'])).toBeNull();
  });
});
