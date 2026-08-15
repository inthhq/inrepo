import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { writeLockfile } from "../lockfile/write-lockfile.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import { buildLockGraph } from "./build-lock-graph.js";
import { renderDependencyTree } from "./render-dependency-tree.js";
import type {
  DependencyGraph,
  ResolvedNode,
} from "./resolve-dependency-graph.js";
import {
  dependencyModules,
  graphClosure,
  graphRoots,
  readVendoredGraph,
} from "./vendored-graph.js";
import { verifyLockGraph } from "./verify-lock-graph.js";

const node = function node(
  partial: Partial<ResolvedNode> & { name: string }
): ResolvedNode {
  return {
    commit: partial.name.padEnd(40, "0"),
    dependencies: {},
    gitUrl: `https://github.com/test/${partial.name}.git`,
    module: partial.name,
    ref: null,
    repositoryDirectory: null,
    resolvedDependencies: {},
    reused: false,
    root: false,
    version: "1.0.0",
    ...partial,
  };
};

const graph: DependencyGraph = {
  nodes: [
    node({
      dependencies: { beta: "^1.0.0", gamma: "~2.0.0" },
      name: "alpha",
      resolvedDependencies: {
        beta: { module: "beta", range: "^1.0.0", version: "1.4.0" },
        gamma: { module: "gamma", range: "~2.0.0", version: "2.0.3" },
      },
      root: true,
    }),
    node({
      dependencies: { gamma: "~2.0.0" },
      name: "beta",
      resolvedDependencies: {
        gamma: { module: "gamma", range: "~2.0.0", version: "2.0.3" },
      },
      version: "1.4.0",
    }),
    node({ name: "gamma", version: "2.0.3" }),
  ],
  rootModule: "alpha",
  rootName: "alpha",
};

describe("buildLockGraph", () => {
  test("records every node and edge with its range, version, and module", () => {
    expect(buildLockGraph(graph)).toEqual({
      alpha: {
        dependencies: {
          beta: { module: "beta", range: "^1.0.0", version: "1.4.0" },
          gamma: { module: "gamma", range: "~2.0.0", version: "2.0.3" },
        },
        root: true,
        version: "1.0.0",
      },
      beta: {
        dependencies: {
          gamma: { module: "gamma", range: "~2.0.0", version: "2.0.3" },
        },
        version: "1.4.0",
      },
      gamma: { version: "2.0.3" },
    });
  });

  test("omits a version the root checkout does not declare", () => {
    const built = buildLockGraph({
      nodes: [node({ name: "alpha", root: true, version: null })],
      rootModule: "alpha",
      rootName: "alpha",
    });
    expect(built.alpha).toEqual({ root: true });
  });

  test("round-trips through the graph query helpers", () => {
    const built = buildLockGraph(graph);
    expect(graphRoots(built)).toEqual(["alpha"]);
    expect(dependencyModules(built, "beta")).toEqual({ gamma: "gamma" });
    expect(dependencyModules(built, "gamma")).toEqual({});
    expect(graphClosure(built, "alpha")).toEqual(["alpha", "beta", "gamma"]);
    expect(graphClosure(built, "beta")).toEqual(["beta", "gamma"]);
  });
});

describe("readVendoredGraph", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir("inrepo-graph-read-");
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test("reads a committed graph back without touching the registry", async () => {
    await writeLockfile(cwd, {}, buildLockGraph(graph));
    const read = await readVendoredGraph(cwd);
    expect(graphRoots(read)).toEqual(["alpha"]);
    expect(dependencyModules(read, "alpha")).toEqual({
      beta: "beta",
      gamma: "gamma",
    });
  });

  test("returns an empty graph for a project that has none", async () => {
    expect(await readVendoredGraph(cwd)).toEqual({});
  });
});

describe("renderDependencyTree", () => {
  test("prints the closure with ranges, versions, and short commits", () => {
    expect(renderDependencyTree(graph)).toBe(
      [
        "alpha 1.0.0 (alpha00)",
        "├─ beta ^1.0.0 → 1.4.0 (beta000)",
        "│  └─ gamma ~2.0.0 → 2.0.3 (gamma00)",
        "└─ gamma ~2.0.0 → 2.0.3 (gamma00) (deduped)",
      ].join("\n")
    );
  });

  test("marks reused packages and cycles", () => {
    const cyclic: DependencyGraph = {
      nodes: [
        node({
          dependencies: { beta: "^1.0.0" },
          name: "alpha",
          resolvedDependencies: {
            beta: { module: "beta", range: "^1.0.0", version: "1.0.0" },
          },
          root: true,
        }),
        node({
          dependencies: { beta: "^1.0.0" },
          name: "beta",
          resolvedDependencies: {
            beta: { module: "beta", range: "^1.0.0", version: "1.0.0" },
          },
          reused: true,
        }),
      ],
      rootModule: "alpha",
      rootName: "alpha",
    };
    expect(renderDependencyTree(cyclic)).toBe(
      [
        "alpha 1.0.0 (alpha00)",
        "└─ beta ^1.0.0 → 1.0.0 (beta000) (already vendored)",
        "   └─ beta ^1.0.0 → 1.0.0 (beta000) (already vendored, cycle)",
      ].join("\n")
    );
  });
});

describe("verifyLockGraph", () => {
  const built = buildLockGraph(graph);
  const moduleNames = new Set(["alpha", "beta", "gamma"]);
  const versions = new Map<string, string | null>([
    ["alpha", "1.0.0"],
    ["beta", "1.4.0"],
    ["gamma", "2.0.3"],
  ]);

  test("accepts a graph that matches the lockfile and checkouts", () => {
    expect(
      verifyLockGraph({ graph: built, moduleNames, vendoredVersions: versions })
    ).toEqual([]);
  });

  test("reports a graph node with no lockfile module", () => {
    expect(
      verifyLockGraph({
        graph: built,
        moduleNames: new Set(["alpha", "beta"]),
        vendoredVersions: versions,
      })
    ).toEqual([
      '"gamma" is in the dependency graph but not in inrepo.lock.json "modules"',
    ]);
  });

  test("reports a checkout whose version drifted from the graph", () => {
    const drifted = new Map(versions).set("gamma", "2.1.0");
    expect(
      verifyLockGraph({ graph: built, moduleNames, vendoredVersions: drifted })
    ).toEqual([
      '"gamma": vendored version 2.1.0 does not match graph version 2.0.3',
    ]);
  });

  test("tolerates a checkout with no readable package.json version", () => {
    const missing = new Map(versions).set("gamma", null);
    expect(
      verifyLockGraph({ graph: built, moduleNames, vendoredVersions: missing })
    ).toEqual([]);
  });

  test("reports an edge whose target is not in the graph", () => {
    const broken = structuredClone(built);
    const betaDeps = broken.beta.dependencies;
    if (betaDeps == null) {
      throw new Error("expected beta.dependencies");
    }
    betaDeps.gamma.module = "missing";
    expect(
      verifyLockGraph({
        graph: broken,
        moduleNames,
        vendoredVersions: versions,
      })[0]
    ).toMatch(
      /resolved to module "missing", which is not in the dependency graph/u
    );
  });

  test("reports an edge whose resolved version no longer satisfies its range", () => {
    const broken = structuredClone(built);
    const betaDeps = broken.beta.dependencies;
    if (betaDeps == null) {
      throw new Error("expected beta.dependencies");
    }
    betaDeps.gamma.range = "^3.0.0";
    expect(
      verifyLockGraph({
        graph: broken,
        moduleNames,
        vendoredVersions: versions,
      })[0]
    ).toMatch(
      /"beta" depends on "gamma" \^3\.0\.0, which 2\.0\.3 does not satisfy/u
    );
  });

  test("reports an edge whose module contains a different source package", () => {
    expect(
      verifyLockGraph({
        graph: built,
        moduleNames,
        moduleSources: new Map([
          ["alpha", "alpha"],
          ["beta", "beta"],
          ["gamma", "not-gamma"],
        ]),
        vendoredVersions: versions,
      })
    ).toContain(
      '"beta" depends on "gamma" but module "gamma" contains "not-gamma"'
    );
  });

  test("trusts the immutable pin for graph instances whose checkout version was publish-transformed", () => {
    const instanceGraph = {
      root: {
        dependencies: {
          shared: { module: "shared@2.1.0", range: "^2.0.0", version: "2.1.0" },
        },
        root: true,
      },
      "shared@2.1.0": { version: "2.1.0" },
    };
    expect(
      verifyLockGraph({
        graph: instanceGraph,
        moduleNames: new Set(["root", "shared@2.1.0"]),
        moduleSources: new Map([
          ["root", "root"],
          ["shared@2.1.0", "shared"],
        ]),
        vendoredVersions: new Map([
          ["root", "1.0.0"],
          ["shared@2.1.0", "0.0.0-dev"],
        ]),
      })
    ).toEqual([]);
  });

  test("reports an edge pinned to a version the target no longer holds", () => {
    const broken = structuredClone(built);
    const betaDeps = broken.beta.dependencies;
    if (betaDeps == null) {
      throw new Error("expected beta.dependencies");
    }
    betaDeps.gamma.version = "2.0.1";
    expect(
      verifyLockGraph({
        graph: broken,
        moduleNames,
        vendoredVersions: versions,
      })[0]
    ).toMatch(/at 2\.0\.1, but "gamma" is vendored at 2\.0\.3/u);
  });

  test("an empty graph produces no errors", () => {
    expect(
      verifyLockGraph({
        graph: {},
        moduleNames: new Set(),
        vendoredVersions: new Map(),
      })
    ).toEqual([]);
  });
});
