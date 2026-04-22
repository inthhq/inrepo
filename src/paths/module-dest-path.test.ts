import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { moduleDestPath } from './module-dest-path.js';

describe('moduleDestPath', () => {
  test('returns inrepo_modules/<name> for plain names', () => {
    expect(moduleDestPath('/repo', 'lodash')).toBe(join('/repo', 'inrepo_modules', 'lodash'));
  });

  test('handles scoped names', () => {
    expect(moduleDestPath('/repo', '@clack/prompts')).toBe(
      join('/repo', 'inrepo_modules', '@clack', 'prompts'),
    );
  });

  test('throws on invalid scoped names', () => {
    expect(() => moduleDestPath('/repo', '@nopkg')).toThrow(/missing \//);
    expect(() => moduleDestPath('/repo', '@scope/')).toThrow(/Invalid scoped name/);
  });
});
