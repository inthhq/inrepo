import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
} from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";
import { lockfilePath } from "../paths/lockfile-path.js";
import { normalizeRepositoryDirectory } from "../registry/normalize-repository-directory.js";
import type {
  LockGraph,
  LockGraphEdge,
  LockGraphNode,
} from "../types/lock-graph.js";
import type { LockModule } from "../types/lock-module.js";

/** Modules table keyed by module directory name. */
interface LockModulesByName {
  [name: string]: LockModule;
}

/**
 * Lockfile versions this build understands. Version 2 only adds the optional
 * `graph` section written by `inrepo add --with-deps`; version 3 records a
 * package rooted below its git repository. Older files remain valid and treat
 * every module as repository-rooted.
 */
export const SUPPORTED_LOCKFILE_VERSIONS = [1, 2, 3, 4, 5] as const;

const assertLockModule = function assertLockModule(
  module: JsonValue,
  label: string
): LockModule {
  if (!isJsonObject(module)) {
    throw new Error(`inrepo.lock.json ${label} must be an object`);
  }
  const rec = module;
  for (const key of ["source", "gitUrl", "commit", "updatedAt"]) {
    if (!isString(rec[key])) {
      throw new TypeError(`inrepo.lock.json ${label}.${key} must be a string`);
    }
  }
  if (rec.ref != null && !isString(rec.ref)) {
    throw new Error(`inrepo.lock.json ${label}.ref must be a string or null`);
  }
  if (rec.repositoryDirectory != null && !isString(rec.repositoryDirectory)) {
    throw new Error(
      `inrepo.lock.json ${label}.repositoryDirectory must be a string when set`
    );
  }
  const repositoryDirectory = isString(rec.repositoryDirectory)
    ? normalizeRepositoryDirectory(
        rec.repositoryDirectory,
        `inrepo.lock.json ${label}.repositoryDirectory`
      )
    : null;
  let artifact: LockModule["artifact"];
  if (rec.artifact != null) {
    if (!isJsonObject(rec.artifact)) {
      throw new TypeError(
        `inrepo.lock.json ${label}.artifact must be an object when set`
      );
    }
    const value = rec.artifact;
    if (
      !isString(value.tarballUrl) ||
      !/^https?:\/\//u.test(value.tarballUrl)
    ) {
      throw new Error(
        `inrepo.lock.json ${label}.artifact.tarballUrl must be an HTTP URL`
      );
    }
    if (
      !isString(value.integrity) ||
      !/^[a-z0-9]+-[A-Za-z0-9+/]+={0,2}(?:\s+[a-z0-9]+-[A-Za-z0-9+/]+={0,2})*$/iu.test(
        value.integrity
      )
    ) {
      throw new Error(
        `inrepo.lock.json ${label}.artifact.integrity must be npm SRI`
      );
    }
    artifact = { integrity: value.integrity, tarballUrl: value.tarballUrl };
  }
  // SAFETY: source/gitUrl/commit/updatedAt checked as strings above; ref is string or null.
  const result: LockModule = {
    commit: rec.commit as string,
    gitUrl: rec.gitUrl as string,
    ref: rec.ref as string | null,
    source: rec.source as string,
    updatedAt: rec.updatedAt as string,
  };
  if (repositoryDirectory != null) {
    result.repositoryDirectory = repositoryDirectory;
  }
  if (artifact != null) {
    result.artifact = artifact;
  }
  return result;
};

const assertLockModules = function assertLockModules(
  modules: JsonValue | undefined
): LockModulesByName {
  if (modules == null) {
    return {};
  }
  if (!isJsonObject(modules)) {
    throw new TypeError('inrepo.lock.json "modules" must be an object');
  }
  const out: LockModulesByName = {};
  for (const [name, module] of Object.entries(modules)) {
    out[name] = assertLockModule(module, `modules["${name}"]`);
  }
  return out;
};

const assertGraphEdge = function assertGraphEdge(
  edge: JsonValue,
  label: string
): LockGraphEdge {
  if (!isJsonObject(edge)) {
    throw new Error(`inrepo.lock.json ${label} must be an object`);
  }
  const rec = edge;
  if (!isString(rec.range) || !isString(rec.module)) {
    throw new TypeError(
      `inrepo.lock.json ${label} needs string "range" and "module"`
    );
  }
  if (rec.version != null && !isString(rec.version)) {
    throw new Error(
      `inrepo.lock.json ${label}.version must be a string when set`
    );
  }
  const result: LockGraphEdge = {
    module: rec.module,
    range: rec.range,
  };
  if (isString(rec.version)) {
    result.version = rec.version;
  }
  return result;
};

const assertGraphNode = function assertGraphNode(
  node: JsonValue,
  label: string
): LockGraphNode {
  if (!isJsonObject(node)) {
    throw new Error(`inrepo.lock.json ${label} must be an object`);
  }
  const rec = node;
  if (rec.version != null && !isString(rec.version)) {
    throw new Error(
      `inrepo.lock.json ${label}.version must be a string when set`
    );
  }
  if (rec.root != null && !isBoolean(rec.root)) {
    throw new Error(
      `inrepo.lock.json ${label}.root must be a boolean when set`
    );
  }
  const out: LockGraphNode = {};
  if (isString(rec.version)) {
    out.version = rec.version;
  }
  if (rec.root === true) {
    out.root = true;
  }
  if (rec.dependencies != null) {
    if (!isJsonObject(rec.dependencies)) {
      throw new TypeError(
        `inrepo.lock.json ${label}.dependencies must be an object`
      );
    }
    const dependencies: { [name: string]: LockGraphEdge } = {};
    for (const [name, edge] of Object.entries(rec.dependencies)) {
      dependencies[name] = assertGraphEdge(
        edge,
        `${label}.dependencies["${name}"]`
      );
    }
    out.dependencies = dependencies;
  }
  return out;
};

const assertLockGraph = function assertLockGraph(
  graph: JsonValue | undefined
): LockGraph {
  if (graph == null) {
    return {};
  }
  if (!isJsonObject(graph)) {
    throw new TypeError('inrepo.lock.json "graph" must be an object');
  }
  const out: LockGraph = {};
  for (const [name, node] of Object.entries(graph)) {
    out[name] = assertGraphNode(node, `graph["${name}"]`);
  }
  return out;
};

export const readLockfile = async function readLockfile(cwd: string): Promise<{
  lockfileVersion: number;
  modules: LockModulesByName;
  graph: LockGraph;
}> {
  const p = lockfilePath(cwd);
  if (!existsSync(p)) {
    return { graph: {}, lockfileVersion: 1, modules: {} };
  }
  const raw = await readFile(p, "utf-8");
  let data: JsonValue;
  try {
    // SAFETY: JSON.parse produces a JSON value from file contents.
    data = JSON.parse(raw) as JsonValue;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid inrepo.lock.json: ${err.message}`, {
      cause: error,
    });
  }
  if (!isJsonObject(data)) {
    throw new Error("inrepo.lock.json must be a JSON object");
  }
  const { graph, lockfileVersion, modules } = data;
  // SAFETY: supported versions are exactly the 1–5 numeric tags this build handles.
  if (
    !isNumber(lockfileVersion) ||
    !SUPPORTED_LOCKFILE_VERSIONS.includes(lockfileVersion as 1 | 2 | 3 | 4 | 5)
  ) {
    throw new Error(`Unsupported lockfileVersion: ${String(lockfileVersion)}`);
  }
  return {
    graph: assertLockGraph(graph),
    lockfileVersion,
    modules: assertLockModules(modules),
  };
};
