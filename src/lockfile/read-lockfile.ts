import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { lockfilePath } from '../paths/lockfile-path.js';
import { normalizeRepositoryDirectory } from '../registry/normalize-repository-directory.js';
import type { LockGraph, LockGraphEdge, LockGraphNode } from '../types/lock-graph.js';
import type { LockModule } from '../types/lock-module.js';

type LockfileShape = {
  lockfileVersion?: unknown;
  modules?: unknown;
  graph?: unknown;
};

/**
 * Lockfile versions this build understands. Version 2 only adds the optional
 * `graph` section written by `inrepo add --with-deps`; version 3 records a
 * package rooted below its git repository. Older files remain valid and treat
 * every module as repository-rooted.
 */
export const SUPPORTED_LOCKFILE_VERSIONS = [1, 2, 3] as const;

function assertLockModule(module: unknown, label: string): LockModule {
  if (module == null || typeof module !== 'object' || Array.isArray(module)) {
    throw new Error(`inrepo.lock.json ${label} must be an object`);
  }
  const rec = module as Record<string, unknown>;
  for (const key of ['source', 'gitUrl', 'commit', 'updatedAt']) {
    if (typeof rec[key] !== 'string') {
      throw new Error(`inrepo.lock.json ${label}.${key} must be a string`);
    }
  }
  if (rec.ref !== null && typeof rec.ref !== 'string') {
    throw new Error(`inrepo.lock.json ${label}.ref must be a string or null`);
  }
  if (rec.repositoryDirectory != null && typeof rec.repositoryDirectory !== 'string') {
    throw new Error(
      `inrepo.lock.json ${label}.repositoryDirectory must be a string when set`,
    );
  }
  const repositoryDirectory =
    typeof rec.repositoryDirectory === 'string'
      ? normalizeRepositoryDirectory(
          rec.repositoryDirectory,
          `inrepo.lock.json ${label}.repositoryDirectory`,
        )
      : null;
  return {
    source: rec.source as string,
    gitUrl: rec.gitUrl as string,
    ...(repositoryDirectory == null ? {} : { repositoryDirectory }),
    commit: rec.commit as string,
    ref: rec.ref as string | null,
    updatedAt: rec.updatedAt as string,
  };
}

function assertLockModules(modules: unknown): Record<string, LockModule> {
  if (modules == null) return {};
  if (typeof modules !== 'object' || Array.isArray(modules)) {
    throw new Error('inrepo.lock.json "modules" must be an object');
  }
  const out: Record<string, LockModule> = {};
  for (const [name, module] of Object.entries(modules as Record<string, unknown>)) {
    out[name] = assertLockModule(module, `modules["${name}"]`);
  }
  return out;
}

function assertGraphEdge(edge: unknown, label: string): LockGraphEdge {
  if (edge == null || typeof edge !== 'object' || Array.isArray(edge)) {
    throw new Error(`inrepo.lock.json ${label} must be an object`);
  }
  const rec = edge as Record<string, unknown>;
  if (typeof rec.range !== 'string' || typeof rec.module !== 'string') {
    throw new Error(`inrepo.lock.json ${label} needs string "range" and "module"`);
  }
  if (rec.version != null && typeof rec.version !== 'string') {
    throw new Error(`inrepo.lock.json ${label}.version must be a string when set`);
  }
  return {
    range: rec.range,
    module: rec.module,
    ...(typeof rec.version === 'string' ? { version: rec.version } : {}),
  };
}

function assertGraphNode(node: unknown, label: string): LockGraphNode {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`inrepo.lock.json ${label} must be an object`);
  }
  const rec = node as Record<string, unknown>;
  if (rec.version != null && typeof rec.version !== 'string') {
    throw new Error(`inrepo.lock.json ${label}.version must be a string when set`);
  }
  if (rec.root != null && typeof rec.root !== 'boolean') {
    throw new Error(`inrepo.lock.json ${label}.root must be a boolean when set`);
  }
  const out: LockGraphNode = {};
  if (typeof rec.version === 'string') out.version = rec.version;
  if (rec.root === true) out.root = true;
  if (rec.dependencies != null) {
    if (typeof rec.dependencies !== 'object' || Array.isArray(rec.dependencies)) {
      throw new Error(`inrepo.lock.json ${label}.dependencies must be an object`);
    }
    const dependencies: Record<string, LockGraphEdge> = {};
    for (const [name, edge] of Object.entries(rec.dependencies as Record<string, unknown>)) {
      dependencies[name] = assertGraphEdge(edge, `${label}.dependencies["${name}"]`);
    }
    out.dependencies = dependencies;
  }
  return out;
}

function assertLockGraph(graph: unknown): LockGraph {
  if (graph == null) return {};
  if (typeof graph !== 'object' || Array.isArray(graph)) {
    throw new Error('inrepo.lock.json "graph" must be an object');
  }
  const out: LockGraph = {};
  for (const [name, node] of Object.entries(graph as Record<string, unknown>)) {
    out[name] = assertGraphNode(node, `graph["${name}"]`);
  }
  return out;
}

export async function readLockfile(cwd: string): Promise<{
  lockfileVersion: number;
  modules: Record<string, LockModule>;
  graph: LockGraph;
}> {
  const p = lockfilePath(cwd);
  if (!existsSync(p)) {
    return { lockfileVersion: 1, modules: {}, graph: {} };
  }
  const raw = await readFile(p, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    throw new Error(`Invalid inrepo.lock.json: ${err.message}`);
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('inrepo.lock.json must be a JSON object');
  }
  const rec = data as LockfileShape;
  const lockfileVersion = rec.lockfileVersion;
  if (
    typeof lockfileVersion !== 'number' ||
    !SUPPORTED_LOCKFILE_VERSIONS.includes(lockfileVersion as 1 | 2 | 3)
  ) {
    throw new Error(`Unsupported lockfileVersion: ${String(lockfileVersion)}`);
  }
  return {
    lockfileVersion,
    modules: assertLockModules(rec.modules),
    graph: assertLockGraph(rec.graph),
  };
}
