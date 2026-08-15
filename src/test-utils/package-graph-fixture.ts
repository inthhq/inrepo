import { mkdir, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";
import { runGit } from "./run-git.js";
import { makeTmpDir } from "./tmp-dir.js";

export interface FixtureVersion {
  /** Runtime dependency specifiers published for this version. */
  dependencies?: Record<string, string>;
  /** Extra package.json fields, e.g. `type`, `main`, or `exports`. */
  manifest?: JsonObject;
  /** Source files keyed by relative path. Replaces the default `index.js`. */
  files?: Record<string, string>;
}

export interface FixturePackageSpec {
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
}

export interface PackageGraphFixture {
  /** Base URL to hand the CLI as `INREPO_REGISTRY`. */
  registryUrl: string;
  /** Bare repository path for a package, usable as a git clone URL. */
  gitUrl: (name: string) => string;
  /**
   * Commit on a package's default branch after it has already been vendored.
   * Used to prove a later `--with-deps` stays on the locked commit.
   */
  commitUpstream: (
    name: string,
    files: Record<string, string>,
    message: string
  ) => Promise<string>;
  cleanup: () => Promise<void>;
}

/**
 * A monorepo fixture holds every package at one commit in one repository, so
 * there is no per-package branch to move and `commitUpstream` does not apply.
 */
export type MonorepoPackageGraphFixture = Omit<
  PackageGraphFixture,
  "commitUpstream"
> & {
  /** The single commit every package subtree was published at. */
  commit: string;
  /** `insteadOf` config that maps the public URL onto the local bare repository. */
  gitConfigPath: string;
};

export interface MonorepoFixturePackageSpec {
  name: string;
  directory: string;
  version: string;
  /** Dependencies in the git checkout, before publishing rewrites workspace ranges. */
  checkoutDependencies?: Record<string, string>;
  /** Exact dependencies exposed by the npm registry manifest. */
  publishedDependencies?: Record<string, string>;
  manifest?: JsonObject;
  files?: Record<string, string>;
}

const safeDirName = function safeDirName(name: string): string {
  return name.replaceAll("@", "").replaceAll("/", "-");
};

const buildPackageRepo = async function buildPackageRepo(
  root: string,
  spec: FixturePackageSpec
): Promise<string> {
  const bare = nodePath.join(root, `${safeDirName(spec.name)}.git`);
  const work = nodePath.join(root, `${safeDirName(spec.name)}-work`);
  await runGit(["init", "--bare", "-b", "main", bare]);
  await runGit(["init", "-b", "main", work]);
  await mkdir(work, { recursive: true });

  for (const [version, manifest] of Object.entries(spec.versions)) {
    const packageJson: JsonObject = {
      main: "index.js",
      name: spec.checkoutName ?? spec.name,
      version,
      ...manifest.manifest,
    };
    if (manifest.dependencies) {
      packageJson.dependencies = manifest.dependencies;
    }
    await writeFile(
      nodePath.join(work, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf-8"
    );
    if (manifest.files) {
      for (const [path, contents] of Object.entries(manifest.files)) {
        const abs = nodePath.join(work, ...path.split("/"));
        await mkdir(nodePath.dirname(abs), { recursive: true });
        await writeFile(abs, contents, "utf-8");
      }
    } else {
      await writeFile(
        nodePath.join(work, "index.js"),
        `module.exports = ${JSON.stringify(`${spec.name}@${version}`)};\n`,
        "utf-8"
      );
    }
    await runGit(["add", "--all", "."], work);
    await runGit(["commit", "-m", `${spec.name} ${version}`], work);
    if (!spec.untagged) {
      await runGit(["tag", `v${version}`], work);
    }
  }

  await runGit(["remote", "add", "origin", bare], work);
  await runGit(["push", "-u", "origin", "main"], work);
  if (!spec.untagged) {
    await runGit(["push", "origin", "--tags"], work);
  }
  return bare;
};

const packumentFor = function packumentFor(
  spec: FixturePackageSpec,
  bare: string
): JsonObject {
  const versions: JsonObject = {};
  for (const [version, manifest] of Object.entries(spec.versions)) {
    const versionEntry: JsonObject = {
      name: spec.name,
      version,
    };
    if (manifest.dependencies) {
      versionEntry.dependencies = manifest.dependencies;
    }
    versions[version] = versionEntry;
  }
  const published = Object.keys(spec.versions);
  const packument: JsonObject = {
    "dist-tags": { latest: published.at(-1) ?? published[0] ?? "0.0.0" },
    name: spec.name,
    versions,
  };
  if (!spec.noRepository) {
    const repository: JsonObject = {
      type: "git",
      url: bare,
    };
    if (spec.repositoryDirectory != null) {
      repository.directory = spec.repositoryDirectory;
    }
    packument.repository = repository;
  }
  return packument;
};

/**
 * Build a self-contained npm-like universe: one local git repository per
 * package (tagged per version) plus an HTTP registry that serves matching
 * packuments. Everything an `--with-deps` run needs, with no network access.
 */
export const makePackageGraphFixture = async function makePackageGraphFixture(
  specs: FixturePackageSpec[],
  prefix = "inrepo-graph-fixture-"
): Promise<PackageGraphFixture> {
  const root = await makeTmpDir(prefix);
  const repos = new Map<string, string>();
  const workRepos = new Map<string, string>();
  const packuments = new Map<string, JsonObject>();

  for (const spec of specs) {
    const bare = await buildPackageRepo(root, spec);
    repos.set(spec.name, bare);
    workRepos.set(
      spec.name,
      nodePath.join(root, `${safeDirName(spec.name)}-work`)
    );
    packuments.set(spec.name, packumentFor(spec, bare));
  }

  const server = Bun.serve({
    fetch(request) {
      const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
      const packument = packuments.get(name);
      if (!packument) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json(packument);
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  return {
    cleanup: async () => {
      await server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
    commitUpstream: async (name, files, message) => {
      const work = workRepos.get(name);
      if (!work) {
        throw new Error(`No fixture work tree for "${name}"`);
      }
      for (const [relPath, contents] of Object.entries(files)) {
        const abs = nodePath.join(work, relPath);
        await mkdir(nodePath.dirname(abs), { recursive: true });
        await writeFile(abs, contents, "utf-8");
      }
      await runGit(["add", "--all", "."], work);
      await runGit(["commit", "-m", message], work);
      await runGit(["push", "origin", "HEAD"], work);
      return runGit(["rev-parse", "HEAD"], work);
    },
    gitUrl(name: string): string {
      const url = repos.get(name);
      if (!url) {
        throw new Error(`No fixture repository for "${name}"`);
      }
      return url;
    },
    registryUrl: `http://127.0.0.1:${server.port}`,
  };
};

/**
 * Build several packages at one commit in one repository. Each packument points
 * at its package subtree through `repository.directory`.
 */
export const makeMonorepoPackageGraphFixture =
  async function makeMonorepoPackageGraphFixture(
    specs: MonorepoFixturePackageSpec[],
    prefix = "inrepo-monorepo-graph-fixture-"
  ): Promise<MonorepoPackageGraphFixture> {
    const root = await makeTmpDir(prefix);
    const bare = nodePath.join(root, "monorepo.git");
    const work = nodePath.join(root, "monorepo-work");
    await runGit(["init", "--bare", "-b", "main", bare]);
    await runGit(["init", "-b", "main", work]);
    await mkdir(work, { recursive: true });
    await writeFile(
      nodePath.join(work, "package.json"),
      `${JSON.stringify({ name: "fixture-workspace", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
      "utf-8"
    );

    for (const spec of specs) {
      const packageRoot = nodePath.join(work, ...spec.directory.split("/"));
      await mkdir(packageRoot, { recursive: true });
      const packageJson: JsonObject = {
        main: "index.js",
        name: spec.name,
        version: spec.version,
        ...spec.manifest,
      };
      if (spec.checkoutDependencies) {
        packageJson.dependencies = spec.checkoutDependencies;
      }
      await writeFile(
        nodePath.join(packageRoot, "package.json"),
        `${JSON.stringify(packageJson, null, 2)}\n`,
        "utf-8"
      );
      for (const [path, contents] of Object.entries(
        spec.files ?? {
          "index.js": `module.exports = ${JSON.stringify(spec.name)};\n`,
        }
      )) {
        const abs = nodePath.join(packageRoot, ...path.split("/"));
        await mkdir(nodePath.dirname(abs), { recursive: true });
        await writeFile(abs, contents, "utf-8");
      }
    }

    await runGit(["add", "--all", "."], work);
    await runGit(["commit", "-m", "publish workspace packages"], work);
    const commit = await (await runGit(["rev-parse", "HEAD"], work)).trim();
    for (const version of new Set(specs.map((spec) => spec.version))) {
      await runGit(["tag", `v${version}`], work);
    }
    await runGit(["remote", "add", "origin", bare], work);
    await runGit(["push", "-u", "origin", "main"], work);
    await runGit(["push", "origin", "--tags"], work);

    const publicGitUrl = "https://github.com/inrepo-fixture/monorepo.git";
    const gitConfigPath = nodePath.join(root, "gitconfig");
    await writeFile(
      gitConfigPath,
      `[url "${bare}"]\n\tinsteadOf = ${publicGitUrl}\n`,
      "utf-8"
    );

    const packuments = new Map<string, JsonObject>();
    for (const spec of specs) {
      const repository = {
        directory: spec.directory,
        type: "git",
        url: publicGitUrl,
      };
      const versionEntry: JsonObject = {
        name: spec.name,
        repository,
        version: spec.version,
      };
      if (spec.publishedDependencies) {
        versionEntry.dependencies = spec.publishedDependencies;
      }
      packuments.set(spec.name, {
        "dist-tags": { latest: spec.version },
        name: spec.name,
        repository,
        versions: {
          [spec.version]: versionEntry,
        },
      });
    }

    const server = Bun.serve({
      fetch(request) {
        const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
        const packument = packuments.get(name);
        if (packument) {
          return Response.json(packument);
        }
        return Response.json({ error: "Not found" }, { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });

    return {
      cleanup: async () => {
        await server.stop(true);
        await rm(root, { force: true, recursive: true });
      },
      commit,
      gitConfigPath,
      gitUrl(name: string): string {
        if (!packuments.has(name)) {
          throw new Error(`No fixture package "${name}"`);
        }
        return publicGitUrl;
      },
      registryUrl: `http://127.0.0.1:${server.port}`,
    };
  };
