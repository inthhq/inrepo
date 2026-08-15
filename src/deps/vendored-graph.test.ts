import { describe, expect, test } from 'bun:test';
import type { LockGraph } from '../types/lock-graph.js';
import { dependencyModules, graphClosure, graphRoots, orderByDependencies } from './vendored-graph.js';

const GRAPH: LockGraph = {
  alpha: {
    version: '1.0.0',
    root: true,
    dependencies: {
      beta: { range: '^1.0.0', version: '1.2.0', module: 'beta' },
      gamma: { range: '^2.0.0', version: '2.1.0', module: 'gamma' },
    },
  },
  beta: {
    version: '1.2.0',
    dependencies: { gamma: { range: '^2.0.0', version: '2.1.0', module: 'gamma' } },
  },
  gamma: { version: '2.1.0' },
};

function names(packages: Array<{ name: string }>): string[] {
  return packages.map((pkg) => pkg.name);
}

describe('vendored graph helpers', () => {
  test('reads roots, edges, and closures', () => {
    expect(graphRoots(GRAPH)).toEqual(['alpha']);
    expect(dependencyModules(GRAPH, 'alpha')).toEqual({ beta: 'beta', gamma: 'gamma' });
    expect(dependencyModules(GRAPH, 'gamma')).toEqual({});
    expect(graphClosure(GRAPH, 'alpha')).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('orderByDependencies', () => {
  test('puts every dependency before the package that needs it', () => {
    const ordered = orderByDependencies(
      [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
      GRAPH,
    );
    expect(names(ordered)).toEqual(['gamma', 'beta', 'alpha']);
  });

  test('keeps packages outside the graph in their original order', () => {
    const ordered = orderByDependencies(
      [{ name: 'one' }, { name: 'alpha' }, { name: 'two' }, { name: 'beta' }, { name: 'gamma' }],
      GRAPH,
    );
    expect(names(ordered)).toEqual(['one', 'gamma', 'beta', 'alpha', 'two']);
  });

  test('ignores edges to packages that are not being vendored', () => {
    const ordered = orderByDependencies([{ name: 'alpha' }, { name: 'gamma' }], GRAPH);
    expect(names(ordered)).toEqual(['gamma', 'alpha']);
  });

  test('falls back to the original order inside a dependency cycle', () => {
    const cyclic: LockGraph = {
      one: { dependencies: { two: { range: '*', module: 'two' } } },
      two: { dependencies: { one: { range: '*', module: 'one' } } },
    };
    const ordered = orderByDependencies([{ name: 'one' }, { name: 'two' }], cyclic);
    expect(names(ordered).sort()).toEqual(['one', 'two']);
  });

  test('returns the input unchanged when there is no graph', () => {
    const ordered = orderByDependencies([{ name: 'b' }, { name: 'a' }], {});
    expect(names(ordered)).toEqual(['b', 'a']);
  });
});
