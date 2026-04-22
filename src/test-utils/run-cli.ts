import { resolve } from 'node:path';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');

export type RunCliOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Bytes to write to the CLI's stdin (e.g. answers to interactive prompts). */
  stdin?: string;
};

export type RunCliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** Spawn `bun src/cli.ts ...args` and capture stdout/stderr/exit code. */
export async function runCli(args: string[], opts: RunCliOptions): Promise<RunCliResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc = Bun.spawn(['bun', CLI_PATH, ...args], {
    cwd: opts.cwd,
    env,
    stdin: opts.stdin == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
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

  return { stdout, stderr, exitCode };
}
