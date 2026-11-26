import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ExecFileFailure extends Error {
  code?: string;
  stderr?: string | Buffer;
}

/** Run `git <args>` with `input` on stdin; resolves with trimmed stdout. */
export const runGitInput = async function runGitInput(
  args: string[],
  input: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  const pending = execFileAsync("git", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    env: opts.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  pending.child.stdin?.end(input);
  try {
    const { stdout } = await pending;
    return stdout.trim();
  } catch (error) {
    // SAFETY: node execFile rejects with Error & { code, stderr }.
    const failure = error as ExecFileFailure;
    if (failure.code === "ENOENT") {
      throw new Error(
        `Failed to spawn git: ${failure.message}. Is git installed and on your PATH?`,
        { cause: error }
      );
    }
    const stderr = String(failure.stderr ?? "")
      .trim()
      .slice(-2000);
    throw new Error(
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
      { cause: error }
    );
  }
};
