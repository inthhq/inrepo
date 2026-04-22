import { spawn } from 'node:child_process';

/** Platform-aware bit-bucket path for `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`. */
export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Run `git <args>` (optionally inside `cwd`) with author/committer identity
 * pinned and global/system config redirected to a null device, so test runs are
 * not influenced by the developer's local git setup. Resolves with trimmed
 * stdout, rejects with a message that includes stderr on non-zero exit.
 */
export function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Inrepo Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Inrepo Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_SYSTEM: NULL_DEVICE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}
