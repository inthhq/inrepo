import { describe, expect, test } from "bun:test";

import type { RegistryPackage } from "../registry/load-registry-package.js";
import type { PublishedArtifact } from "../types/published-artifact.js";
import { resolveDependencyGraph } from "./resolve-dependency-graph.js";
import type {
  GraphResolverIo,
  GraphRoot,
  VendoredPackage,
} from "./resolve-dependency-graph.js";

interface FakeVersion {
  dependencies?: Record<string, string>;
  /** null models a package whose npm metadata has no usable repository. */
  gitUrl?: string | null;
  repositoryDirectory?: string | null;
  /** false models a repository that never tagged the version. */
  tagged?: boolean;
  artifact?: PublishedArtifact;
}

type FakeRegistry = Record<string, Record<string, FakeVersion>>;

const commitFor = function commitFor(name: string, version: string): string {
  return `${name}${version}`
    .replaceAll(/[^0-9a-f]/giu, "0")
    .padEnd(40, "0")
    .slice(0, 40);
};

const makeIo = function makeIo(
  registry: FakeRegistry
): GraphResolverIo & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    loadRegistryPackage(name: string): Promise<RegistryPackage> {
      fetched.push(name);
      const versions = registry[name];
      if (!versions) {
        return Promise.reject(
          new Error(`npm registry: package not found: ${name}`)
        );
      }
      return Promise.resolve({
        manifests: Object.entries(versions).map(([version, manifest]) => ({
          artifact: manifest.artifact ?? null,
          attestationsUrl: null,
          dependencies: manifest.dependencies ?? {},
          distIntegrity: null,
          gitHead: null,
          gitUrl:
            manifest.gitUrl === undefined
              ? `https://github.com/test/${name.replace("@", "").replace("/", "-")}.git`
              : manifest.gitUrl,
          repositoryDirectory: manifest.repositoryDirectory ?? null,
          version,
        })),
        name,
      });
    },
    resolveRepositoryDirectory(candidate) {
      return Promise.resolve(candidate.repositoryDirectory);
    },
    resolveVersionPins(manifest, name: string) {
      const tagged = registry[name]?.[manifest.version]?.tagged;
      if (tagged === false) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          commit: commitFor(name, manifest.version),
          ref: `v${manifest.version}`,
        },
      ]);
    },
  };
};

const makeRoot = function makeRoot(
  dependencies: Record<string, string>,
  name = "root"
): GraphRoot {
  return {
    commit: commitFor(name, "1.0.0"),
    dependencies,
    gitUrl: `https://github.com/test/${name}.git`,
    name,
    ref: null,
    repositoryDirectory: null,
    version: "1.0.0",
  };
};

const resolve = function resolve(
  registry: FakeRegistry,
  root: GraphRoot,
  vendored = new Map<string, VendoredPackage>()
) {
  return resolveDependencyGraph({ io: makeIo(registry), root, vendored });
};

describe("resolveDependencyGraph", () => {
  test("walks a multi-level closure and pins each level", async () => {
    const graph = await resolve(
      {
        beta: {
          "1.0.0": { dependencies: { gamma: "^2.0.0" } },
          "1.4.0": { dependencies: { gamma: "^2.0.0" } },
        },
        delta: { "3.0.0": {} },
        gamma: { "2.0.0": {}, "2.3.1": { dependencies: { delta: "^3.0.0" } } },
      },
      makeRoot({ beta: "^1.0.0" })
    );

    expect(graph.nodes.map((node) => `${node.name}@${node.version}`)).toEqual([
      "root@1.0.0",
      "beta@1.4.0",
      "delta@3.0.0",
      "gamma@2.3.1",
    ]);
    expect(graph.nodes[1].ref).toBe("v1.4.0");
    expect(graph.nodes[1].root).toBe(false);
    expect(graph.nodes[0].root).toBe(true);
  });

  test("retains the exact published artifact on each selected instance", async () => {
    const artifact = {
      integrity: "sha512-YWJj",
      tarballUrl: "https://registry.npmjs.org/beta/-/beta-1.0.0.tgz",
    };
    const graph = await resolve(
      { beta: { "1.0.0": { artifact } } },
      makeRoot({ beta: "1.0.0" })
    );
    expect(graph.nodes.find((node) => node.name === "beta")?.artifact).toEqual(
      artifact
    );
    expect(graph.nodes.find((node) => node.root)?.artifact).toBeNull();
  });

  test("ignores devDependencies and peerDependencies of the root", async () => {
    const graph = await resolve(
      { beta: { "1.0.0": {} } },
      makeRoot({ beta: "^1.0.0" })
    );
    // The fake registry has no `only-dev` package at all: resolution would fail
    // if dev/peer dependencies were walked.
    expect(graph.nodes.map((node) => node.name)).toEqual(["root", "beta"]);
  });

  test("vendors a shared dependency exactly once", async () => {
    const graph = await resolve(
      {
        beta: { "1.0.0": { dependencies: { shared: "^1.0.0" } } },
        gamma: { "1.0.0": { dependencies: { shared: "^1.2.0" } } },
        shared: { "1.0.0": {}, "1.5.0": {}, "2.0.0": {} },
      },
      makeRoot({ beta: "^1.0.0", gamma: "^1.0.0" })
    );

    const shared = graph.nodes.filter((node) => node.name === "shared");
    expect(shared).toHaveLength(1);
    // Overlapping ranges unify onto one version satisfying both.
    expect(shared[0].version).toBe("1.5.0");
  });

  test("fetches each package from the registry only once", async () => {
    const io = makeIo({
      beta: { "1.0.0": { dependencies: { shared: "^1.0.0" } } },
      gamma: { "1.0.0": { dependencies: { shared: "^1.0.0" } } },
      shared: { "1.0.0": {} },
    });
    await resolveDependencyGraph({
      io,
      root: makeRoot({ beta: "^1.0.0", gamma: "^1.0.0" }),
      vendored: new Map(),
    });
    expect(io.fetched.filter((name) => name === "shared")).toHaveLength(1);
  });

  test("keeps incompatible dependency requirements as separate module instances", async () => {
    const graph = await resolve(
      {
        beta: { "1.0.0": { dependencies: { shared: "^1.0.0" } } },
        gamma: { "1.0.0": { dependencies: { shared: "^2.0.0" } } },
        shared: { "1.0.0": {}, "2.0.0": {} },
      },
      makeRoot({ beta: "^1.0.0", gamma: "^1.0.0" })
    );

    expect(
      graph.nodes
        .filter((node) => node.name === "shared")
        .map((node) => node.module)
    ).toEqual(["shared@1.0.0", "shared@2.0.0"]);
    const beta = graph.nodes.find((node) => node.name === "beta");
    const gamma = graph.nodes.find((node) => node.name === "gamma");
    expect(beta?.resolvedDependencies.shared.module).toBe("shared@1.0.0");
    expect(gamma?.resolvedDependencies.shared.module).toBe("shared@2.0.0");
  });

  test("names the dependent and reason for an unsupported specifier", async () => {
    await expect(
      resolve(
        { beta: { "1.0.0": { dependencies: { local: "workspace:^" } } } },
        makeRoot({ beta: "^1.0.0" })
      )
    ).rejects.toThrow(
      /"beta" depends on "local" as "workspace:\^" \(workspace protocol/u
    );
  });

  test("fails when the registry has no repository for a dependency", async () => {
    await expect(
      resolve(
        { beta: { "1.0.0": { gitUrl: null } } },
        makeRoot({ beta: "^1.0.0" })
      )
    ).rejects.toThrow(/no usable "repository" clone URL/u);
  });

  test("fails when no tag matches the resolved version", async () => {
    await expect(
      resolve(
        { beta: { "1.0.0": { tagged: false } } },
        makeRoot({ beta: "^1.0.0" })
      )
    ).rejects.toThrow(/no tag for "beta@1\.0\.0"/u);
  });

  test("reuses a compatible already vendored package instead of re-pinning it", async () => {
    const vendored = new Map<string, VendoredPackage>([
      [
        "beta",
        {
          commit: "b".repeat(40),
          dependencies: { gamma: "^2.0.0" },
          gitUrl: "https://github.com/test/beta.git",
          name: "beta",
          ref: "v1.1.0",
          repositoryDirectory: null,
          version: "1.1.0",
        },
      ],
    ]);
    const graph = await resolve(
      { beta: { "1.9.0": {} }, gamma: { "2.0.0": {} } },
      makeRoot({ beta: "^1.0.0" }),
      vendored
    );

    const beta = graph.nodes.find((node) => node.name === "beta");
    expect(beta?.version).toBe("1.1.0");
    expect(beta?.reused).toBe(true);
    expect(beta?.commit).toBe("b".repeat(40));
    // The reused checkout's own dependencies are still part of the closure.
    expect(graph.nodes.map((node) => node.name)).toContain("gamma");
  });

  test("reuses published ranges on a vendored monorepo package instead of workspace specifiers", async () => {
    const vendored = new Map<string, VendoredPackage>([
      [
        "beta",
        {
          commit: "b".repeat(40),
          // Published range, as describeVendored reconstructs from lock/packument.
          dependencies: { gamma: "^2.0.0" },
          gitUrl: "https://github.com/test/workspace.git",
          name: "beta",
          ref: "v1.0.0",
          repositoryDirectory: "packages/beta",
          version: "1.0.0",
        },
      ],
    ]);
    const graph = await resolve(
      {
        beta: { "1.0.0": { dependencies: { gamma: "workspace:*" } } },
        gamma: { "2.0.0": {} },
      },
      makeRoot({ beta: "^1.0.0" }),
      vendored
    );

    const beta = graph.nodes.find((node) => node.name === "beta");
    expect(beta?.reused).toBe(true);
    expect(beta?.dependencies).toEqual({ gamma: "^2.0.0" });
    expect(graph.nodes.map((node) => node.name)).toEqual([
      "root",
      "beta",
      "gamma",
    ]);
    expect(beta?.resolvedDependencies.gamma).toMatchObject({
      module: "gamma@2.0.0",
      range: "^2.0.0",
      version: "2.0.0",
    });
  });

  test("coexists with an already vendored incompatible package", async () => {
    const vendored = new Map<string, VendoredPackage>([
      [
        "beta",
        {
          commit: "b".repeat(40),
          dependencies: {},
          gitUrl: "https://github.com/test/beta.git",
          name: "beta",
          ref: "v1.1.0",
          repositoryDirectory: null,
          version: "1.1.0",
        },
      ],
    ]);
    const graph = await resolve(
      { beta: { "2.0.0": {} } },
      makeRoot({ beta: "^2.0.0" }),
      vendored
    );
    expect(graph.nodes.find((node) => node.name === "beta")?.module).toBe(
      "beta@2.0.0"
    );
  });

  test("terminates on a dependency cycle", async () => {
    const graph = await resolve(
      {
        beta: { "1.0.0": { dependencies: { gamma: "^1.0.0" } } },
        gamma: { "1.0.0": { dependencies: { beta: "^1.0.0" } } },
      },
      makeRoot({ beta: "^1.0.0" })
    );
    expect(graph.nodes.map((node) => node.name)).toEqual([
      "root",
      "beta",
      "gamma",
    ]);
  });

  test("ignores a dependency that points back at the root", async () => {
    const graph = await resolve(
      { beta: { "1.0.0": { dependencies: { root: "^1.0.0" } } } },
      makeRoot({ beta: "^1.0.0" })
    );
    expect(graph.nodes.map((node) => node.name)).toEqual(["root", "beta"]);
  });

  test("a root with no dependencies resolves to just itself", async () => {
    const graph = await resolve({}, makeRoot({}));
    expect(graph.nodes.map((node) => node.name)).toEqual(["root"]);
  });

  test("propagates repository directories for root, resolved, and reused nodes", async () => {
    const root = {
      ...makeRoot({ beta: "^1.0.0", reused: "^1.0.0" }),
      repositoryDirectory: "packages/root",
    };
    const vendored = new Map<string, VendoredPackage>([
      [
        "reused",
        {
          commit: "e".repeat(40),
          dependencies: {},
          gitUrl: "https://github.com/test/workspace.git",
          name: "reused",
          ref: "v1.0.0",
          repositoryDirectory: "packages/reused",
          version: "1.0.0",
        },
      ],
    ]);
    const graph = await resolve(
      {
        beta: { "1.0.0": { repositoryDirectory: "packages/beta" } },
        reused: { "1.0.0": {} },
      },
      root,
      vendored
    );
    expect(
      Object.fromEntries(
        graph.nodes.map((node) => [node.name, node.repositoryDirectory])
      )
    ).toEqual({
      beta: "packages/beta",
      reused: "packages/reused",
      root: "packages/root",
    });
  });
});
