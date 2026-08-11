import { spawn } from 'node:child_process';

export function runGitCapture(
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Trim surrounding whitespace from stdout (default true). */
    trim?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn git: ${err.message}. Is git installed and on your PATH?`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve(opts.trim === false ? stdout : stdout.trim());
      else {
        const tail = stderr.trim().slice(-2000);
        reject(new Error(`git ${args.join(' ')} failed (exit ${code})${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}
