import { describe, expect, test } from "bun:test";

import type { LockGraph } from "../types/lock-graph.js";
import { refreshGraphVersion } from "./refresh-graph-version.js";

const graph: LockGraph = {
  alpha: {
    dependencies: {
      beta: { module: "beta", range: "^1.0.0", version: "1.0.0" },
      gamma: { module: "gamma", range: "^2.0.0", version: "2.0.0" },
    },
    root: true,
    version: "1.0.0",
  },
  beta: {
    dependencies: {
      gamma: { module: "gamma", range: "^2.0.0", version: "2.0.0" },
    },
    version: "1.0.0",
  },
  gamma: { version: "2.0.0" },
};

describe("refreshGraphVersion", () => {
  test("moves the node version and every edge pointing at it", () => {
    const { nodes, violations } = refreshGraphVersion({
      graph,
      name: "gamma",
      version: "2.1.0",
    });
    expect(violations).toEqual([]);
    expect(nodes).toEqual({
      alpha: {
        dependencies: {
          beta: { module: "beta", range: "^1.0.0", version: "1.0.0" },
          gamma: { module: "gamma", range: "^2.0.0", version: "2.1.0" },
        },
        root: true,
        version: "1.0.0",
      },
      beta: {
        dependencies: {
          gamma: { module: "gamma", range: "^2.0.0", version: "2.1.0" },
        },
        version: "1.0.0",
      },
      gamma: { version: "2.1.0" },
    });
    // The input is left untouched, so a failed write cannot half-apply.
    expect(graph.gamma.version).toBe("2.0.0");
  });

  test("leaves packages that do not depend on the moved one alone", () => {
    const { nodes } = refreshGraphVersion({
      graph,
      name: "beta",
      version: "1.2.0",
    });
    expect(Object.keys(nodes).toSorted()).toEqual(["alpha", "beta"]);
    expect(nodes.beta.version).toBe("1.2.0");
    expect(nodes.alpha.dependencies?.beta.version).toBe("1.2.0");
    // Untouched edges keep their recorded resolution.
    expect(nodes.alpha.dependencies?.gamma.version).toBe("2.0.0");
  });

  test("reports every dependent whose range the new version escapes", () => {
    const { nodes, violations } = refreshGraphVersion({
      graph,
      name: "gamma",
      version: "3.0.0",
    });
    expect(violations).toEqual([
      { dependency: "gamma", dependent: "alpha", range: "^2.0.0" },
      { dependency: "gamma", dependent: "beta", range: "^2.0.0" },
    ]);
    // The version is still recorded: the graph tracks what is vendored.
    expect(nodes.gamma.version).toBe("3.0.0");
    expect(nodes.alpha.dependencies?.gamma.version).toBe("3.0.0");
  });

  test("a package with no graph node changes nothing", () => {
    expect(
      refreshGraphVersion({ graph, name: "delta", version: "1.0.0" })
    ).toEqual({
      nodes: {},
      violations: [],
    });
  });

  test("an unchanged version produces no nodes to write", () => {
    expect(
      refreshGraphVersion({ graph, name: "gamma", version: "2.0.0" })
    ).toEqual({
      nodes: {},
      violations: [],
    });
  });

  test("fills in a version the node and its edges never recorded", () => {
    const partial: LockGraph = {
      alpha: {
        dependencies: { beta: { module: "beta", range: "*" } },
        root: true,
      },
      beta: {},
    };
    const { nodes, violations } = refreshGraphVersion({
      graph: partial,
      name: "beta",
      version: "1.0.0",
    });
    expect(violations).toEqual([]);
    expect(nodes.beta).toEqual({ version: "1.0.0" });
    expect(nodes.alpha.dependencies?.beta).toEqual({
      module: "beta",
      range: "*",
      version: "1.0.0",
    });
  });
});
