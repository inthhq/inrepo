import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Platform-aware bit-bucket path for `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`. */
export const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

interface ExecFileFailure extends Error {
  stderr?: string | Buffer;
  status?: number | null;
}

/**
 * Run `git <args>` (optionally inside `cwd`) with author/committer identity
 * pinned and global/system config redirected to a null device, so test runs are
 * not influenced by the developer's local git setup. Resolves with trimmed
 * stdout, rejects with a message that includes stderr on non-zero exit.
 */
export const runGit = async function runGit(
  args: string[],
  cwd?: string
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_AUTHOR_NAME: "Inrepo Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Inrepo Test",
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_SYSTEM: NULL_DEVICE,
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    const text = Buffer.isBuffer(stdout) ? stdout.toString("utf-8") : stdout;
    return text.trim();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw new Error(`git ${args.join(" ")} failed: ${String(error)}`, {
        cause: error,
      });
    }
    // SAFETY: node execFile rejects with Error & { stderr, status }.
    const err = error as ExecFileFailure;
    let stderr = "";
    if (err.stderr != null) {
      stderr = Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf-8")
        : err.stderr;
    }
    throw new Error(
      `git ${args.join(" ")} failed (${err.status ?? "unknown"}): ${stderr.trim()}`,
      { cause: error }
    );
  }
};
