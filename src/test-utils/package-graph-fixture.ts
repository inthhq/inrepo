import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runGit } from './run-git.js';
import { makeTmpDir } from './tmp-dir.js';

export type FixtureVersion = {
  /** Runtime dependency specifiers published for this version. */
  dependencies?: Record<string, string>;
  /** Extra package.json fields, e.g. `type`, `main`, or `exports`. */
  manifest?: Record<string, unknown>;
  /** Source files keyed by relative path. Replaces the default `index.js`. */
  files?: Record<string, string>;
};

export type FixturePackageSpec = {
  name: string;
  /** Different name at the git checkout root, to model a monorepo workspace. */
  checkoutName?: string;
  /** Versions in ascending order; each becomes a commit plus a `v<version>` tag. */
  versions: Record<string, FixtureVersion>;
  /** Serve a packument with no `repository` field. */
  noRepository?: boolean;
  /** Package root advertised by npm for this otherwise single-package repo. */
  repositoryDirectory?: string;
  /** Commit the versions but never tag them. */
  untagged?: boolean;
};

export type PackageGraphFixture = {
  /** Base URL to hand the CLI as `INREPO_REGISTRY`. */
  registryUrl: string;
  /** Bare repository path for a package, usable as a git clone URL. */
  gitUrl(name: string): string;
  /**
   * Commit on a package's default branch after it has already been vendored.
   * Used to prove a later `--with-deps` stays on the locked commit.
   */
  commitUpstream(name: string, files: Record<string, string>, message: string): Promise<string>;
  cleanup(): Promise<void>;
};

/**
 * A monorepo fixture holds every package at one commit in one repository, so
 * there is no per-package branch to move and `commitUpstream` does not apply.
 */
export type MonorepoPackageGraphFixture = Omit<PackageGraphFixture, 'commitUpstream'> & {
  /** The single commit every package subtree was published at. */
  commit: string;
  /** `insteadOf` config that maps the public URL onto the local bare repository. */
  gitConfigPath: string;
};

export type MonorepoFixturePackageSpec = {
  name: string;
  directory: string;
  version: string;
  /** Dependencies in the git checkout, before publishing rewrites workspace ranges. */
  checkoutDependencies?: Record<string, string>;
  /** Exact dependencies exposed by the npm registry manifest. */
  publishedDependencies?: Record<string, string>;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
};

function safeDirName(name: string): string {
  return name.replaceAll('@', '').replaceAll('/', '-');
}

async function buildPackageRepo(root: string, spec: FixturePackageSpec): Promise<string> {
  const bare = join(root, `${safeDirName(spec.name)}.git`);
  const work = join(root, `${safeDirName(spec.name)}-work`);
  await runGit(['init', '--bare', '-b', 'main', bare]);
  await runGit(['init', '-b', 'main', work]);
  await mkdir(work, { recursive: true });

  for (const [version, manifest] of Object.entries(spec.versions)) {
    await writeFile(
      join(work, 'package.json'),
      `${JSON.stringify(
        {
          name: spec.checkoutName ?? spec.name,
          version,
          main: 'index.js',
          ...(manifest.manifest ?? {}),
          ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    if (manifest.files) {
      for (const [path, contents] of Object.entries(manifest.files)) {
        const abs = join(work, ...path.split('/'));
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, contents, 'utf8');
      }
    } else {
      await writeFile(
        join(work, 'index.js'),
        `module.exports = ${JSON.stringify(`${spec.name}@${version}`)};\n`,
        'utf8',
      );
    }
    await runGit(['add', '--all', '.'], work);
    await runGit(['commit', '-m', `${spec.name} ${version}`], work);
    if (!spec.untagged) await runGit(['tag', `v${version}`], work);
  }

  await runGit(['remote', 'add', 'origin', bare], work);
  await runGit(['push', '-u', 'origin', 'main'], work);
  if (!spec.untagged) await runGit(['push', 'origin', '--tags'], work);
  return bare;
}

function packumentFor(spec: FixturePackageSpec, bare: string): Record<string, unknown> {
  const versions: Record<string, unknown> = {};
  for (const [version, manifest] of Object.entries(spec.versions)) {
    versions[version] = {
      name: spec.name,
      version,
      ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
    };
  }
  const published = Object.keys(spec.versions);
  return {
    name: spec.name,
    'dist-tags': { latest: published[published.length - 1] },
    ...(spec.noRepository
      ? {}
      : {
          repository: {
            type: 'git',
            url: bare,
            ...(spec.repositoryDirectory == null ? {} : { directory: spec.repositoryDirectory }),
          },
        }),
    versions,
  };
}

/**
 * Build a self-contained npm-like universe: one local git repository per
 * package (tagged per version) plus an HTTP registry that serves matching
 * packuments. Everything an `--with-deps` run needs, with no network access.
 */
export async function makePackageGraphFixture(
  specs: FixturePackageSpec[],
  prefix = 'inrepo-graph-fixture-',
): Promise<PackageGraphFixture> {
  const root = await makeTmpDir(prefix);
  const repos = new Map<string, string>();
  const workRepos = new Map<string, string>();
  const packuments = new Map<string, Record<string, unknown>>();

  for (const spec of specs) {
    const bare = await buildPackageRepo(root, spec);
    repos.set(spec.name, bare);
    workRepos.set(spec.name, join(root, `${safeDirName(spec.name)}-work`));
    packuments.set(spec.name, packumentFor(spec, bare));
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const packument = packuments.get(name);
      if (!packument) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(packument), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    registryUrl: `http://127.0.0.1:${server.port}`,
    gitUrl(name: string): string {
      const url = repos.get(name);
      if (!url) throw new Error(`No fixture repository for "${name}"`);
      return url;
    },
    commitUpstream: async (name, files, message) => {
      const work = workRepos.get(name);
      if (!work) throw new Error(`No fixture work tree for "${name}"`);
      for (const [relPath, contents] of Object.entries(files)) {
        const abs = join(work, relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, contents, 'utf8');
      }
      await runGit(['add', '--all', '.'], work);
      await runGit(['commit', '-m', message], work);
      await runGit(['push', 'origin', 'HEAD'], work);
      return runGit(['rev-parse', 'HEAD'], work);
    },
    cleanup: async () => {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Build several packages at one commit in one repository. Each packument points
 * at its package subtree through `repository.directory`.
 */
export async function makeMonorepoPackageGraphFixture(
  specs: MonorepoFixturePackageSpec[],
  prefix = 'inrepo-monorepo-graph-fixture-',
): Promise<MonorepoPackageGraphFixture> {
  const root = await makeTmpDir(prefix);
  const bare = join(root, 'monorepo.git');
  const work = join(root, 'monorepo-work');
  await runGit(['init', '--bare', '-b', 'main', bare]);
  await runGit(['init', '-b', 'main', work]);
  await mkdir(work, { recursive: true });
  await writeFile(
    join(work, 'package.json'),
    `${JSON.stringify({ name: 'fixture-workspace', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
    'utf8',
  );

  for (const spec of specs) {
    const packageRoot = join(work, ...spec.directory.split('/'));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: spec.name,
          version: spec.version,
          main: 'index.js',
          ...(spec.manifest ?? {}),
          ...(spec.checkoutDependencies ? { dependencies: spec.checkoutDependencies } : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    for (const [path, contents] of Object.entries(
      spec.files ?? {
        'index.js': `module.exports = ${JSON.stringify(spec.name)};\n`,
      },
    )) {
      const abs = join(packageRoot, ...path.split('/'));
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contents, 'utf8');
    }
  }

  await runGit(['add', '--all', '.'], work);
  await runGit(['commit', '-m', 'publish workspace packages'], work);
  const commit = (await runGit(['rev-parse', 'HEAD'], work)).trim();
  for (const version of new Set(specs.map((spec) => spec.version))) {
    await runGit(['tag', `v${version}`], work);
  }
  await runGit(['remote', 'add', 'origin', bare], work);
  await runGit(['push', '-u', 'origin', 'main'], work);
  await runGit(['push', 'origin', '--tags'], work);

  const publicGitUrl = 'https://github.com/inrepo-fixture/monorepo.git';
  const gitConfigPath = join(root, 'gitconfig');
  await writeFile(gitConfigPath, `[url "${bare}"]\n\tinsteadOf = ${publicGitUrl}\n`, 'utf8');

  const packuments = new Map<string, Record<string, unknown>>();
  for (const spec of specs) {
    const repository = {
      type: 'git',
      url: publicGitUrl,
      directory: spec.directory,
    };
    packuments.set(spec.name, {
      name: spec.name,
      'dist-tags': { latest: spec.version },
      repository,
      versions: {
        [spec.version]: {
          name: spec.name,
          version: spec.version,
          repository,
          ...(spec.publishedDependencies ? { dependencies: spec.publishedDependencies } : {}),
        },
      },
    });
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const packument = packuments.get(name);
      return packument
        ? new Response(JSON.stringify(packument), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
    },
  });

  return {
    registryUrl: `http://127.0.0.1:${server.port}`,
    gitUrl(name: string): string {
      if (!packuments.has(name)) throw new Error(`No fixture package "${name}"`);
      return publicGitUrl;
    },
    commit,
    gitConfigPath,
    cleanup: async () => {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
