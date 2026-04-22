import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTmpDir } from './tmp-dir.js';
import { runGit } from './run-git.js';

export type LocalGitFixture = {
  /** Path to the bare repo (use as the clone URL). */
  url: string;
  /** Commit SHA of the first ("v1") commit. */
  c1: string;
  /** Commit SHA of the second ("v2") commit, which is HEAD on `main`. */
  c2: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a local bare git repository with two commits on `main`. The repository
 * contains a small tree (`README.md`, `src/index.ts`, `docs/guide.md`,
 * `package.json`) suitable for exercising sync, keep, and exclude.
 */
export async function makeLocalGitFixture(prefix = 'inrepo-fixture-'): Promise<LocalGitFixture> {
  const root = await makeTmpDir(prefix);
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');

  await runGit(['init', '--bare', '-b', 'main', bare]);
  await runGit(['init', '-b', 'main', work]);

  await mkdir(join(work, 'src'), { recursive: true });
  await mkdir(join(work, 'docs'), { recursive: true });
  await writeFile(join(work, 'README.md'), '# upstream v1\n', 'utf8');
  await writeFile(join(work, 'src', 'index.ts'), 'export const v = 1;\n', 'utf8');
  await writeFile(join(work, 'docs', 'guide.md'), '# guide\n', 'utf8');
  await writeFile(
    join(work, 'package.json'),
    JSON.stringify({ name: 'upstream', version: '1.0.0' }, null, 2) + '\n',
    'utf8',
  );
  await runGit(['add', '.'], work);
  await runGit(['commit', '-m', 'first'], work);
  const c1 = await runGit(['rev-parse', 'HEAD'], work);

  await writeFile(join(work, 'CHANGELOG.md'), '# v2\n', 'utf8');
  await writeFile(join(work, 'src', 'index.ts'), 'export const v = 2;\n', 'utf8');
  await runGit(['add', '.'], work);
  await runGit(['commit', '-m', 'second'], work);
  const c2 = await runGit(['rev-parse', 'HEAD'], work);

  await runGit(['remote', 'add', 'origin', bare], work);
  await runGit(['push', '-u', 'origin', 'main'], work);

  return {
    url: bare,
    c1,
    c2,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
