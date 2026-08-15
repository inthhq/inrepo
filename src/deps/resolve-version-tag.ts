import { runGitCapture } from '../git/run-git-capture.js';
import { parseLsRemote, type RemoteRefRow } from '../git/resolve-remote-commit.js';

export type VersionTag = {
  /** Tag name to record as the package's `ref`. */
  ref: string;
  /** Commit the tag points at, peeled through annotated tag objects. */
  commit: string;
};

function bareName(name: string): string {
  const slash = name.indexOf('/');
  return name.startsWith('@') && slash !== -1 ? name.slice(slash + 1) : name;
}

/**
 * Tag names a published version is plausibly released under, most conventional
 * first. `v1.2.3` and `1.2.3` cover the overwhelming majority; the rest cover
 * the monorepo conventions (`pkg@1.2.3`, `pkg-v1.2.3`).
 */
export function versionTagCandidates(name: string, version: string): string[] {
  const bare = bareName(name);
  return [
    ...new Set([
      `v${version}`,
      version,
      `${name}@${version}`,
      `${bare}@${version}`,
      `${bare}@v${version}`,
      `${bare}-v${version}`,
      `${bare}-${version}`,
    ]),
  ];
}

/** Choose the first candidate tag the remote advertises, preferring peeled commits. */
export function pickVersionTag(rows: RemoteRefRow[], candidates: string[]): VersionTag | null {
  const byRef = new Map(rows.map((row) => [row.ref, row.commit] as const));
  for (const candidate of candidates) {
    const peeled = byRef.get(`refs/tags/${candidate}^{}`);
    if (peeled) return { ref: candidate, commit: peeled };
    const direct = byRef.get(`refs/tags/${candidate}`);
    if (direct) return { ref: candidate, commit: direct };
  }
  return null;
}

/** List every tag a remote advertises, without cloning it. */
export async function listRemoteTags(gitUrl: string): Promise<RemoteRefRow[]> {
  const raw = await runGitCapture(['ls-remote', '--tags', gitUrl], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return parseLsRemote(raw);
}

/** Map `name@version` onto the tag and commit that published it. */
export async function resolveVersionTag(
  gitUrl: string,
  name: string,
  version: string,
): Promise<VersionTag | null> {
  return pickVersionTag(await listRemoteTags(gitUrl), versionTagCandidates(name, version));
}
