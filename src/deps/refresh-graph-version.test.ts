import { describe, expect, test } from 'bun:test';
import type { LockGraph } from '../types/lock-graph.js';
import { refreshGraphVersion } from './refresh-graph-version.js';

const graph: LockGraph = {
  alpha: {
    version: '1.0.0',
    root: true,
    dependencies: {
      beta: { range: '^1.0.0', version: '1.0.0', module: 'beta' },
      gamma: { range: '^2.0.0', version: '2.0.0', module: 'gamma' },
    },
  },
  beta: {
    version: '1.0.0',
    dependencies: { gamma: { range: '^2.0.0', version: '2.0.0', module: 'gamma' } },
  },
  gamma: { version: '2.0.0' },
};

describe('refreshGraphVersion', () => {
  test('moves the node version and every edge pointing at it', () => {
    const { nodes, violations } = refreshGraphVersion({ graph, name: 'gamma', version: '2.1.0' });
    expect(violations).toEqual([]);
    expect(nodes).toEqual({
      gamma: { version: '2.1.0' },
      alpha: {
        version: '1.0.0',
        root: true,
        dependencies: {
          beta: { range: '^1.0.0', version: '1.0.0', module: 'beta' },
          gamma: { range: '^2.0.0', version: '2.1.0', module: 'gamma' },
        },
      },
      beta: {
        version: '1.0.0',
        dependencies: { gamma: { range: '^2.0.0', version: '2.1.0', module: 'gamma' } },
      },
    });
    // The input is left untouched, so a failed write cannot half-apply.
    expect(graph.gamma.version).toBe('2.0.0');
  });

  test('leaves packages that do not depend on the moved one alone', () => {
    const { nodes } = refreshGraphVersion({ graph, name: 'beta', version: '1.2.0' });
    expect(Object.keys(nodes).sort()).toEqual(['alpha', 'beta']);
    expect(nodes.beta.version).toBe('1.2.0');
    expect(nodes.alpha.dependencies?.beta.version).toBe('1.2.0');
    // Untouched edges keep their recorded resolution.
    expect(nodes.alpha.dependencies?.gamma.version).toBe('2.0.0');
  });

  test('reports every dependent whose range the new version escapes', () => {
    const { nodes, violations } = refreshGraphVersion({ graph, name: 'gamma', version: '3.0.0' });
    expect(violations).toEqual([
      { dependent: 'alpha', dependency: 'gamma', range: '^2.0.0' },
      { dependent: 'beta', dependency: 'gamma', range: '^2.0.0' },
    ]);
    // The version is still recorded: the graph tracks what is vendored.
    expect(nodes.gamma.version).toBe('3.0.0');
    expect(nodes.alpha.dependencies?.gamma.version).toBe('3.0.0');
  });

  test('a package with no graph node changes nothing', () => {
    expect(refreshGraphVersion({ graph, name: 'delta', version: '1.0.0' })).toEqual({
      nodes: {},
      violations: [],
    });
  });

  test('an unchanged version produces no nodes to write', () => {
    expect(refreshGraphVersion({ graph, name: 'gamma', version: '2.0.0' })).toEqual({
      nodes: {},
      violations: [],
    });
  });

  test('fills in a version the node and its edges never recorded', () => {
    const partial: LockGraph = {
      alpha: { root: true, dependencies: { beta: { range: '*', module: 'beta' } } },
      beta: {},
    };
    const { nodes, violations } = refreshGraphVersion({
      graph: partial,
      name: 'beta',
      version: '1.0.0',
    });
    expect(violations).toEqual([]);
    expect(nodes.beta).toEqual({ version: '1.0.0' });
    expect(nodes.alpha.dependencies?.beta).toEqual({
      range: '*',
      version: '1.0.0',
      module: 'beta',
    });
  });
});
