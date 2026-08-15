import { runGitCapture } from "./run-git-capture.js";

const FULL_SHA = /^[0-9a-f]{40}$/iu;
const ABBREVIATED_SHA = /^[0-9a-f]{7,40}$/iu;

export interface RemoteRefRow {
  commit: string;
  /** Full ref name as advertised by the remote, e.g. `refs/heads/main`. */
  ref: string;
}

/** Parse `git ls-remote` output into `<commit> <ref>` rows. */
export const parseLsRemote = function parseLsRemote(
  raw: string
): RemoteRefRow[] {
  const rows: RemoteRefRow[] = [];
  for (const line of raw.split("\n")) {
    const match = /^(?<g1>[0-9a-f]{40})\s+(?<g2>\S+)$/iu.exec(line.trim());
    if (!match) {
      continue;
    }
    rows.push({ commit: match[1].toLowerCase(), ref: match[2] });
  }
  return rows;
};

/**
 * Choose the commit a ref pattern designates.
 *
 * A branch wins over a tag of the same name, and an annotated tag resolves to
 * the commit it peels to (`^{}`) rather than to the tag object.
 */
export const pickRemoteCommit = function pickRemoteCommit(
  rows: RemoteRefRow[],
  pattern: string
): string | null {
  const byRef = (name: string): string | null =>
    rows.find((row) => row.ref === name)?.commit ?? null;
  return (
    byRef(`refs/heads/${pattern}`) ??
    byRef(`refs/tags/${pattern}^{}`) ??
    byRef(`refs/tags/${pattern}`) ??
    byRef(pattern) ??
    rows[0]?.commit ??
    null
  );
};

/**
 * Resolve what a ref currently points at in a remote repository without
 * cloning it. This is how `inrepo update` learns that the branch or tag a
 * package is pinned to has moved.
 *
 * A full commit id resolves to itself, since a pin by commit has no moving tip.
 */
export const resolveRemoteCommit = async function resolveRemoteCommit(
  gitUrl: string,
  ref?: string | null
): Promise<string> {
  const wanted = ref?.trim();
  if (wanted && FULL_SHA.test(wanted)) {
    return wanted.toLowerCase();
  }

  const pattern = wanted && wanted !== "" ? wanted : "HEAD";
  const raw = await runGitCapture(["ls-remote", gitUrl, pattern], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const commit = pickRemoteCommit(parseLsRemote(raw), pattern);

  if (commit == null) {
    if (wanted && ABBREVIATED_SHA.test(wanted)) {
      throw new Error(
        `Cannot resolve a moving tip from ref "${wanted}" in ${gitUrl}: it looks like a commit id. Pass --ref <branch or tag> to move the pin.`
      );
    }
    throw new Error(
      wanted
        ? `Could not resolve ref "${wanted}" in ${gitUrl}`
        : `Could not resolve the default branch in ${gitUrl}`
    );
  }
  return commit;
};
