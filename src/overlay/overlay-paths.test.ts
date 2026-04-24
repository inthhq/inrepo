import { describe, expect, test } from 'bun:test';
import { moduleStatePath, overlayDirPath, pristineDirPath } from './overlay-paths.js';

describe('overlay paths', () => {
  test('builds paths for valid package names', () => {
    expect(overlayDirPath('/repo', 'left-pad')).toBe('/repo/inrepo_patches/left-pad');
    expect(pristineDirPath('/repo', '@scope/pkg')).toBe('/repo/.inrepo/pristine/@scope/pkg');
    expect(moduleStatePath('/repo', '@scope/pkg')).toBe('/repo/.inrepo/state/@scope/pkg.json');
  });

  test('rejects traversal and separator segments', () => {
    expect(() => overlayDirPath('/repo', '..')).toThrow(/traversal segments are not allowed/);
    expect(() => overlayDirPath('/repo', 'pkg/nested')).toThrow(/path separators are not allowed/);
    expect(() => overlayDirPath('/repo', '@scope/../pkg')).toThrow(/path separators are not allowed/);
    expect(() => overlayDirPath('/repo', '/tmp/pkg')).toThrow(/absolute paths are not allowed/);
    expect(() => overlayDirPath('/repo', '@scope/.')).toThrow(/traversal segments are not allowed/);
  });
});
