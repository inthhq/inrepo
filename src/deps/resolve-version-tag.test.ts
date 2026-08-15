import { describe, expect, test } from 'bun:test';
import { parseLsRemote } from '../git/resolve-remote-commit.js';
import { pickVersionTag, versionTagCandidates } from './resolve-version-tag.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('versionTagCandidates', () => {
  test('puts the conventional tag names first', () => {
    expect(versionTagCandidates('commander', '9.4.1').slice(0, 2)).toEqual(['v9.4.1', '9.4.1']);
  });

  test('covers monorepo tag conventions for scoped names', () => {
    const candidates = versionTagCandidates('@scope/pkg', '1.2.3');
    expect(candidates).toContain('@scope/pkg@1.2.3');
    expect(candidates).toContain('pkg@1.2.3');
    expect(candidates).toContain('pkg-v1.2.3');
  });

  test('does not repeat a candidate for an unscoped name', () => {
    const candidates = versionTagCandidates('pkg', '1.2.3');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe('pickVersionTag', () => {
  test('prefers the peeled commit of an annotated tag', () => {
    const rows = parseLsRemote([`${A}\trefs/tags/v1.2.3`, `${B}\trefs/tags/v1.2.3^{}`].join('\n'));
    expect(pickVersionTag(rows, versionTagCandidates('pkg', '1.2.3'))).toEqual({
      ref: 'v1.2.3',
      commit: B,
    });
  });

  test('falls back to a lightweight tag', () => {
    const rows = parseLsRemote(`${A}\trefs/tags/1.2.3`);
    expect(pickVersionTag(rows, versionTagCandidates('pkg', '1.2.3'))).toEqual({
      ref: '1.2.3',
      commit: A,
    });
  });

  test('honors candidate priority over remote order', () => {
    const rows = parseLsRemote(
      [`${A}\trefs/tags/pkg@1.2.3`, `${B}\trefs/tags/v1.2.3`].join('\n'),
    );
    expect(pickVersionTag(rows, versionTagCandidates('pkg', '1.2.3'))?.ref).toBe('v1.2.3');
  });

  test('returns null when the remote has no matching tag', () => {
    const rows = parseLsRemote(`${A}\trefs/tags/v9.9.9`);
    expect(pickVersionTag(rows, versionTagCandidates('pkg', '1.2.3'))).toBeNull();
  });
});
