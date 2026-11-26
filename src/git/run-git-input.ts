import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ExecFileFailure extends Error {
  code?: string;
  stderr?: string | Buffer;
}

interface RunGitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const formatFailure = function formatFailure(
  failure: ExecFileFailure,
  args: string[]
): Error {
  if (failure.code === "ENOENT") {
    return new Error(
      `Failed to spawn git: ${failure.message}. Is git installed and on your PATH?`,
      { cause: failure }
    );
  }
  const stderr = String(failure.stderr ?? "")
    .trim()
    .slice(-2000);
  return new Error(
    `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    { cause: failure }
  );
};

/** Run `git <args>` with `input` on stdin; resolves with trimmed stdout. */
export const runGitInput = async function runGitInput(
  args: string[],
  input: string,
  opts: RunGitOptions = {}
): Promise<string> {
  const pending = execFileAsync("git", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    env: opts.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  // If git exits before reading all of stdin, report git's error, not EPIPE.
  pending.child.stdin?.on("error", () => {
    // Ignored: the rejected promise below carries git's stderr.
  });
  pending.child.stdin?.end(input);
  try {
    const { stdout } = await pending;
    return stdout.trim();
  } catch (error) {
    // SAFETY: node execFile rejects with Error & { code, stderr }.
    throw formatFailure(error as ExecFileFailure, args);
  }
};

/** Run `git <args>` and return raw stdout bytes (for paths that may not be UTF-8). */
export const runGitBytes = async function runGitBytes(
  args: string[],
  opts: RunGitOptions = {}
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      encoding: "buffer",
      env: opts.env,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // SAFETY: node execFile rejects with Error & { code, stderr }.
    throw formatFailure(error as ExecFileFailure, args);
  }
};
