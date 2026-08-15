import { lstat, readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../../../src/json/unknown.js";
import { runtimeDir } from "./runtime.ts";

interface Stats {
  bytes: number;
  files: number;
}

const treeStats = async function treeStats(
  root: string,
  skipNodeModules = false
): Promise<Stats> {
  const out: Stats = { bytes: 0, files: 0 };
  const walk = async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skipNodeModules && entry.name === "node_modules") {
        continue;
      }
      const path = nodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        out.files += 1;
        out.bytes += (await lstat(path)).size;
      }
    }
  };
  await walk(root);
  return out;
};

const formatBytes = function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const resolveInstalledPackage = async function resolveInstalledPackage(
  start: string,
  name: string
): Promise<string> {
  let cursor = start;
  while (true) {
    const candidate = nodePath.join(cursor, "node_modules", ...name.split("/"));
    try {
      if (
        await (await lstat(nodePath.join(candidate, "package.json"))).isFile()
      ) {
        return candidate;
      }
    } catch {
      // Package not installed at this node_modules level; keep walking up.
    }
    const parent = nodePath.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Cannot resolve installed ${name} from ${start}`);
    }
    cursor = parent;
  }
};

const npmClosure = async function npmClosure(
  root: string
): Promise<{ packages: number; stats: Stats }> {
  const queue = [root];
  const seen = new Set<string>();
  const stats: Stats = { bytes: 0, files: 0 };
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) {
      break;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const own = await treeStats(current, true);
    stats.bytes += own.bytes;
    stats.files += own.files;
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const manifest = JSON.parse(
      await readFile(nodePath.join(current, "package.json"), "utf-8")
    ) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(
      manifest.dependencies ?? {}
    ).toSorted()) {
      queue.push(await resolveInstalledPackage(current, dependency));
    }
  }
  return { packages: seen.size, stats };
};

const runtime = await runtimeDir();
const npmRoot = nodePath.resolve(
  import.meta.dir,
  "..",
  "node_modules",
  "@c15t",
  "cli"
);
const npm = await npmClosure(npmRoot);
// SAFETY: value was parsed or constructed by the surrounding function before this assertion.
const lock = JSON.parse(
  await readFile(nodePath.join(runtime, "inrepo.lock.json"), "utf-8")
) as {
  modules: JsonObject;
};
const inrepoModules = await treeStats(nodePath.join(runtime, "inrepo_modules"));
const repositories = await treeStats(
  nodePath.join(runtime, ".inrepo", "repositories")
);
const artifacts = await treeStats(
  nodePath.join(runtime, ".inrepo", "artifacts")
);
const packageViews = await treeStats(
  nodePath.join(runtime, ".inrepo", "cache")
);

console.log(
  `npm dependency closure: ${npm.packages} packages, ${npm.stats.files} files, ${formatBytes(npm.stats.bytes)}`
);
console.log(
  `inrepo module closure:   ${Object.keys(lock.modules).length} modules, ${inrepoModules.files} files, ${formatBytes(inrepoModules.bytes)}`
);
console.log(
  `inrepo git cache:        ${repositories.files} files, ${formatBytes(repositories.bytes)}`
);
console.log(
  `inrepo artifact cache:   ${artifacts.files} files, ${formatBytes(artifacts.bytes)}`
);
console.log(
  `inrepo package views:    ${packageViews.files} files, ${formatBytes(packageViews.bytes)}`
);
