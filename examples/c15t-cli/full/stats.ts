import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runtimeDir } from './runtime.ts';

type Stats = { bytes: number; files: number };

async function treeStats(root: string, skipNodeModules = false): Promise<Stats> {
  const out: Stats = { bytes: 0, files: 0 };
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skipNodeModules && entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        out.files++;
        out.bytes += (await lstat(path)).size;
      }
    }
  }
  await walk(root);
  return out;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function resolveInstalledPackage(start: string, name: string): Promise<string> {
  let cursor = start;
  while (true) {
    const candidate = join(cursor, 'node_modules', ...name.split('/'));
    try {
      if ((await lstat(join(candidate, 'package.json'))).isFile()) return candidate;
    } catch {}
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve installed ${name} from ${start}`);
    cursor = parent;
  }
}

async function npmClosure(root: string): Promise<{ packages: number; stats: Stats }> {
  const queue = [root];
  const seen = new Set<string>();
  const stats: Stats = { bytes: 0, files: 0 };
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const own = await treeStats(current, true);
    stats.bytes += own.bytes;
    stats.files += own.files;
    const manifest = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      queue.push(await resolveInstalledPackage(current, dependency));
    }
  }
  return { packages: seen.size, stats };
}

const runtime = await runtimeDir();
const npmRoot = resolve(import.meta.dir, '..', 'node_modules', '@c15t', 'cli');
const npm = await npmClosure(npmRoot);
const lock = JSON.parse(await readFile(join(runtime, 'inrepo.lock.json'), 'utf8')) as {
  modules: Record<string, unknown>;
};
const inrepoModules = await treeStats(join(runtime, 'inrepo_modules'));
const repositories = await treeStats(join(runtime, '.inrepo', 'repositories'));
const artifacts = await treeStats(join(runtime, '.inrepo', 'artifacts'));
const packageViews = await treeStats(join(runtime, '.inrepo', 'cache'));

console.log(`npm dependency closure: ${npm.packages} packages, ${npm.stats.files} files, ${formatBytes(npm.stats.bytes)}`);
console.log(`inrepo module closure:   ${Object.keys(lock.modules).length} modules, ${inrepoModules.files} files, ${formatBytes(inrepoModules.bytes)}`);
console.log(`inrepo git cache:        ${repositories.files} files, ${formatBytes(repositories.bytes)}`);
console.log(`inrepo artifact cache:   ${artifacts.files} files, ${formatBytes(artifacts.bytes)}`);
console.log(`inrepo package views:    ${packageViews.files} files, ${formatBytes(packageViews.bytes)}`);
