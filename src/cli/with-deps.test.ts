import { describe, expect, test } from 'bun:test';
import { resolveExistingRootPin } from './with-deps.js';

describe('resolveExistingRootPin', () => {
  const lock = {
    gitUrl: 'git@private:alpha.git',
    ref: 'v1.0.0',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };

  test('defaults git, ref, and commit to the recorded pin', () => {
    expect(resolveExistingRootPin({}, lock)).toEqual({
      git: lock.gitUrl,
      ref: lock.ref,
      commit: lock.commit,
    });
  });

  test('honors a caller-supplied pin even when git is already filled in', () => {
    expect(
      resolveExistingRootPin({ git: lock.gitUrl, ref: lock.ref, commit: lock.commit }, lock),
    ).toEqual({
      git: lock.gitUrl,
      ref: lock.ref,
      commit: lock.commit,
    });
  });

  test('fetches a moving tip when --git is passed', () => {
    expect(resolveExistingRootPin({ git: 'https://example.com/alpha.git' }, lock)).toEqual({
      git: 'https://example.com/alpha.git',
      ref: undefined,
      commit: null,
    });
  });

  test('fetches a moving tip when --ref is passed', () => {
    expect(resolveExistingRootPin({ ref: 'v2.0.0' }, lock)).toEqual({
      git: lock.gitUrl,
      ref: 'v2.0.0',
      commit: null,
    });
  });

  test('resolves from npm when nothing is recorded', () => {
    expect(resolveExistingRootPin({})).toEqual({
      git: undefined,
      ref: undefined,
      commit: null,
    });
  });
});
