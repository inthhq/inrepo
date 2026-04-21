import { runGit } from './run-git.js';
import { runGitCapture } from './run-git-capture.js';

function looksLikeSha(ref: string): boolean {
  return ref.length >= 7 && ref.length <= 40 && /^[0-9a-f]+$/i.test(ref);
}

export type ClonePackageOptions = {
  dest: string;
  gitUrl: string;
  ref?: string;
};

/** Clone a git repository into dest and return resolved HEAD + origin URL. */
export async function clonePackage({
  dest,
  gitUrl,
  ref,
}: ClonePackageOptions): Promise<{ commit: string; originUrl: string }> {
  const shallowArgs = ['--depth', '1'];

  if (!ref) {
    await runGit(['clone', ...shallowArgs, gitUrl, dest]);
  } else if (looksLikeSha(ref)) {
    await runGit(['init', dest]);
    await runGit(['remote', 'add', 'origin', gitUrl], { cwd: dest });
    await runGit(['fetch', ...shallowArgs, 'origin', ref], { cwd: dest });
    await runGit(['checkout', 'FETCH_HEAD'], { cwd: dest });
  } else {
    await runGit(['clone', ...shallowArgs, '--branch', ref, gitUrl, dest]);
  }

  const commit = await runGitCapture(['rev-parse', 'HEAD'], { cwd: dest });
  const originUrl = await runGitCapture(['remote', 'get-url', 'origin'], { cwd: dest });
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`Unexpected commit format from git rev-parse: ${commit}`);
  }
  return { commit: commit.toLowerCase(), originUrl };
}
