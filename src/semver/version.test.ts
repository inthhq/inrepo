import { describe, expect, test } from 'bun:test';
import { compareVersions, isValidVersion, parseVersion } from './version.js';

describe('parseVersion', () => {
  test('parses a plain version', () => {
    expect(parseVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
    });
  });

  test('parses prerelease and build metadata', () => {
    expect(parseVersion('1.0.0-beta.2+build.7')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['beta', 2],
      build: ['build', '7'],
    });
  });

  test('tolerates a leading v', () => {
    expect(parseVersion('v2.0.0')?.major).toBe(2);
  });

  test.each(['1.2', '1.2.3.4', 'latest', '', 'x.y.z'])('rejects %p', (raw) => {
    expect(parseVersion(raw)).toBeNull();
    expect(isValidVersion(raw)).toBe(false);
  });
});

describe('compareVersions', () => {
  test('orders by major, minor, then patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('a prerelease sorts below its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  test('numeric prerelease identifiers compare numerically', () => {
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
  });

  test('numeric prerelease identifiers rank below alphanumeric ones', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  test('a longer prerelease outranks its prefix', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  test('build metadata does not affect precedence', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  test('throws on an unparseable side', () => {
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/Invalid semver version: 1\.0/);
  });
});
