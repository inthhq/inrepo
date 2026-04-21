import { spawn } from 'node:child_process';

export function runGitCapture(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
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
      if (code === 0) resolve(stdout.trim());
      else {
        const tail = stderr.trim().slice(-2000);
        reject(new Error(`git ${args.join(' ')} failed (exit ${code})${tail ? `: ${tail}` : ''}`));
      }
    });
  });
}
