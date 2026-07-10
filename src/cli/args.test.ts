import { describe, expect, test } from 'bun:test';
import { parseAddArgs } from './args.js';

describe('parseAddArgs package.json linking', () => {
  test('defaults to source-only', () => {
    expect(parseAddArgs(['pkg'])).toEqual({
      name: 'pkg',
      save: true,
      git: undefined,
      ref: undefined,
      packageJson: undefined,
    });
  });

  test('selects dependencies explicitly', () => {
    expect(parseAddArgs(['--dependency', 'pkg']).packageJson).toBe('dependencies');
  });

  test('supports every devDependencies alias', () => {
    for (const flag of ['-D', '--dev', '--dev-dependency']) {
      expect(parseAddArgs([flag, 'pkg']).packageJson).toBe('devDependencies');
    }
  });

  test('rejects conflicting targets and unmanaged one-off links', () => {
    expect(() => parseAddArgs(['--dependency', '-D', 'pkg'])).toThrow(
      /cannot be used together/,
    );
    expect(() => parseAddArgs(['--dependency', '--no-save', 'pkg'])).toThrow(
      /cannot be combined with --no-save/,
    );
  });
});
