import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeLockfile } from '../lockfile/write-lockfile.js';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { buildLockGraph } from './build-lock-graph.js';
import { renderDependencyTree } from './render-dependency-tree.js';
import type { DependencyGraph, ResolvedNode } from './resolve-dependency-graph.js';
import {
  dependencyModules,
  graphClosure,
  graphRoots,
  readVendoredGraph,
} from './vendored-graph.js';
import { verifyLockGraph } from './verify-lock-graph.js';

function node(partial: Partial<ResolvedNode> & { name: string }): ResolvedNode {
  return {
    version: '1.0.0',
    gitUrl: `https://github.com/test/${partial.name}.git`,
    ref: null,
    commit: partial.name.padEnd(40, '0'),
    dependencies: {},
    root: false,
    reused: false,
    ...partial,
  };
}

const graph: DependencyGraph = {
  rootName: 'alpha',
  nodes: [
    node({ name: 'alpha', root: true, dependencies: { beta: '^1.0.0', gamma: '~2.0.0' } }),
    node({ name: 'beta', version: '1.4.0', dependencies: { gamma: '~2.0.0' } }),
    node({ name: 'gamma', version: '2.0.3' }),
  ],
};

describe('buildLockGraph', () => {
  test('records every node and edge with its range, version, and module', () => {
    expect(buildLockGraph(graph)).toEqual({
      alpha: {
        version: '1.0.0',
        root: true,
        dependencies: {
          beta: { range: '^1.0.0', version: '1.4.0', module: 'beta' },
          gamma: { range: '~2.0.0', version: '2.0.3', module: 'gamma' },
        },
      },
      beta: {
        version: '1.4.0',
        dependencies: { gamma: { range: '~2.0.0', version: '2.0.3', module: 'gamma' } },
      },
      gamma: { version: '2.0.3' },
    });
  });

  test('omits a version the root checkout does not declare', () => {
    const built = buildLockGraph({
      rootName: 'alpha',
      nodes: [node({ name: 'alpha', root: true, version: null })],
    });
    expect(built.alpha).toEqual({ root: true });
  });

  test('round-trips through the graph query helpers', () => {
    const built = buildLockGraph(graph);
    expect(graphRoots(built)).toEqual(['alpha']);
    expect(dependencyModules(built, 'beta')).toEqual({ gamma: 'gamma' });
    expect(dependencyModules(built, 'gamma')).toEqual({});
    expect(graphClosure(built, 'alpha')).toEqual(['alpha', 'beta', 'gamma']);
    expect(graphClosure(built, 'beta')).toEqual(['beta', 'gamma']);
  });
});

describe('readVendoredGraph', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpDir('inrepo-graph-read-');
  });

  afterEach(async () => {
    await cleanupTmpDir(cwd);
  });

  test('reads a committed graph back without touching the registry', async () => {
    await writeLockfile(cwd, {}, buildLockGraph(graph));
    const read = await readVendoredGraph(cwd);
    expect(graphRoots(read)).toEqual(['alpha']);
    expect(dependencyModules(read, 'alpha')).toEqual({ beta: 'beta', gamma: 'gamma' });
  });

  test('returns an empty graph for a project that has none', async () => {
    expect(await readVendoredGraph(cwd)).toEqual({});
  });
});

describe('renderDependencyTree', () => {
  test('prints the closure with ranges, versions, and short commits', () => {
    expect(renderDependencyTree(graph)).toBe(
      [
        'alpha 1.0.0 (alpha00)',
        '├─ beta ^1.0.0 → 1.4.0 (beta000)',
        '│  └─ gamma ~2.0.0 → 2.0.3 (gamma00)',
        '└─ gamma ~2.0.0 → 2.0.3 (gamma00) (deduped)',
      ].join('\n'),
    );
  });

  test('marks reused packages and cycles', () => {
    const cyclic: DependencyGraph = {
      rootName: 'alpha',
      nodes: [
        node({ name: 'alpha', root: true, dependencies: { beta: '^1.0.0' } }),
        node({ name: 'beta', reused: true, dependencies: { beta: '^1.0.0' } }),
      ],
    };
    expect(renderDependencyTree(cyclic)).toBe(
      [
        'alpha 1.0.0 (alpha00)',
        '└─ beta ^1.0.0 → 1.0.0 (beta000) (already vendored)',
        '   └─ beta ^1.0.0 → 1.0.0 (beta000) (already vendored, cycle)',
      ].join('\n'),
    );
  });
});

describe('verifyLockGraph', () => {
  const built = buildLockGraph(graph);
  const moduleNames = new Set(['alpha', 'beta', 'gamma']);
  const versions = new Map<string, string | null>([
    ['alpha', '1.0.0'],
    ['beta', '1.4.0'],
    ['gamma', '2.0.3'],
  ]);

  test('accepts a graph that matches the lockfile and checkouts', () => {
    expect(verifyLockGraph({ graph: built, moduleNames, vendoredVersions: versions })).toEqual([]);
  });

  test('reports a graph node with no lockfile module', () => {
    expect(
      verifyLockGraph({
        graph: built,
        moduleNames: new Set(['alpha', 'beta']),
        vendoredVersions: versions,
      }),
    ).toEqual(['"gamma" is in the dependency graph but not in inrepo.lock.json "modules"']);
  });

  test('reports a checkout whose version drifted from the graph', () => {
    const drifted = new Map(versions).set('gamma', '2.1.0');
    expect(
      verifyLockGraph({ graph: built, moduleNames, vendoredVersions: drifted }),
    ).toEqual(['"gamma": vendored version 2.1.0 does not match graph version 2.0.3']);
  });

  test('tolerates a checkout with no readable package.json version', () => {
    const missing = new Map(versions).set('gamma', null);
    expect(verifyLockGraph({ graph: built, moduleNames, vendoredVersions: missing })).toEqual([]);
  });

  test('reports an edge whose target is not in the graph', () => {
    const broken = structuredClone(built);
    broken.beta.dependencies!.gamma.module = 'missing';
    expect(
      verifyLockGraph({ graph: broken, moduleNames, vendoredVersions: versions })[0],
    ).toMatch(/resolved to module "missing", which is not in the dependency graph/);
  });

  test('reports an edge whose resolved version no longer satisfies its range', () => {
    const broken = structuredClone(built);
    broken.beta.dependencies!.gamma.range = '^3.0.0';
    expect(
      verifyLockGraph({ graph: broken, moduleNames, vendoredVersions: versions })[0],
    ).toMatch(/"beta" depends on "gamma" \^3\.0\.0, which 2\.0\.3 does not satisfy/);
  });

  test('reports an edge pinned to a version the target no longer holds', () => {
    const broken = structuredClone(built);
    broken.beta.dependencies!.gamma.version = '2.0.1';
    expect(
      verifyLockGraph({ graph: broken, moduleNames, vendoredVersions: versions })[0],
    ).toMatch(/at 2\.0\.1, but "gamma" is vendored at 2\.0\.3/);
  });

  test('an empty graph produces no errors', () => {
    expect(
      verifyLockGraph({ graph: {}, moduleNames: new Set(), vendoredVersions: new Map() }),
    ).toEqual([]);
  });
});
