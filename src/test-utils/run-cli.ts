import nodePath from "node:path";

const CLI_PATH = nodePath.resolve(import.meta.dir, "..", "cli.ts");

export interface RunCliOptions {
  cwd: string;
  env?: { readonly [key: string]: string | undefined };
  /** Bytes to write to the CLI's stdin (e.g. answers to interactive prompts). */
  stdin?: string;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn `bun src/cli.ts ...args` and capture stdout/stderr/exit code. */
export const runCli = async function runCli(
  args: string[],
  opts: RunCliOptions
): Promise<RunCliResult> {
  const overrides = opts.env ?? {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !(k in overrides)) {
      env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) {
      env[k] = v;
    }
  }

  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: opts.cwd,
    env,
    stderr: "pipe",
    stdin: opts.stdin == null ? "ignore" : "pipe",
    stdout: "pipe",
  });

  if (opts.stdin != null && proc.stdin != null) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
};
