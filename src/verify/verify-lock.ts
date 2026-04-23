import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isLoadConfigNotFoundError, loadConfig } from '../config/load-config.js';
import { readLockfile } from '../lockfile/read-lockfile.js';
import { assembleModuleTree } from '../overlay/assemble-module.js';
import { ensurePristine } from '../overlay/cache.js';
import { compareTrees, type CompareTreesResult } from '../overlay/compare-trees.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { runGitCapture } from '../git/run-git-capture.js';
import { normalizeGithubHttpsUrl } from '../registry/normalize-github-https-url.js';
import type { VerifyResult } from '../types/verify-result.js';

const VENDOR_MARKER = '.inrepo-vendor.json';

function remotesEquivalent(a: string, b: string): boolean {
  const na = normalizeGithubHttpsUrl(a) ?? a.replace(/\.git$/i, '').toLowerCase();
  const nb = normalizeGithubHttpsUrl(b) ?? b.replace(/\.git$/i, '').toLowerCase();
  return na === nb;
}

function parseVendorMarker(raw: string): { commit: string; gitUrl: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (data == null || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  const commit = rec.commit;
  const gitUrl = rec.gitUrl;
  if (typeof commit !== 'string' || typeof gitUrl !== 'string') return null;
  return { commit: commit.toLowerCase(), gitUrl };
}

function mergedVendorExcludes(globalExclude: string[], pkg: { exclude?: string[] }): string[] {
  return [...new Set([...globalExclude, ...(pkg.exclude ?? [])])];
}

function mergedVendorKeeps(globalKeep: string[], pkg: { keep?: string[] }): string[] {
  return [...new Set([...globalKeep, ...(pkg.keep ?? [])])];
}

function hasTreeDrift(result: CompareTreesResult): boolean {
  return (
    result.added.length > 0 ||
    result.modified.length > 0 ||
    result.removed.length > 0 ||
    result.typeChanges.length > 0
  );
}

function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 5);
  const suffix = paths.length > shown.length ? `, … (+${paths.length - shown.length} more)` : '';
  return shown.join(', ') + suffix;
}

function formatTreeDrift(name: string, result: CompareTreesResult): string {
  const parts: string[] = [];
  if (result.added.length > 0) parts.push(`unexpected: ${summarizePaths(result.added)}`);
  if (result.modified.length > 0) parts.push(`modified: ${summarizePaths(result.modified)}`);
  if (result.removed.length > 0) parts.push(`missing: ${summarizePaths(result.removed)}`);
  if (result.typeChanges.length > 0) parts.push(`type-changed: ${summarizePaths(result.typeChanges)}`);
  return `"${name}": vendored tree does not match lockfile + overlay (${parts.join('; ')})`;
}

export async function verifyLock(cwd: string): Promise<VerifyResult> {
  const { modules } = await readLockfile(cwd);
  const names = Object.keys(modules);
  if (names.length === 0) {
    return { ok: false, errors: ['No modules in inrepo.lock.json (nothing to verify).'] };
  }

  let configPackages: Array<{
    name: string;
    exclude?: string[];
    keep?: string[];
  }> = [];
  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  try {
    const cfg = await loadConfig(cwd);
    configPackages = cfg.packages;
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
  }
  const configByName = new Map(configPackages.map((pkg) => [pkg.name, pkg] as const));

  const errors: string[] = [];
  const verifyTmpRoot = join(cwd, '.inrepo', 'verify');
  await mkdir(verifyTmpRoot, { recursive: true });

  for (const name of names) {
    const entry = modules[name];
    const dest = moduleDestPath(cwd, name);
    if (!existsSync(dest)) {
      errors.push(`Missing directory for "${name}": ${dest}`);
      continue;
    }
    const st = await stat(dest);
    if (!st.isDirectory()) {
      errors.push(`Path for "${name}" is not a directory: ${dest}`);
      continue;
    }
    const gitDir = join(dest, '.git');
    const markerPath = join(dest, VENDOR_MARKER);
    const pkgConfig = configByName.get(name) ?? { name };
    const keepList = mergedVendorKeeps(globalKeep, pkgConfig);
    const excludeList = mergedVendorExcludes(globalExclude, pkgConfig);

    let pristineDir: string;
    try {
      const pristine = await ensurePristine({
        cwd,
        name,
        gitUrl: entry.gitUrl,
        ref: entry.ref,
        commit: entry.commit,
        keep: keepList,
        exclude: excludeList,
      });
      pristineDir = pristine.dir;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push(`"${name}": ${err.message}`);
      continue;
    }

    const stage = await mkdtemp(join(verifyTmpRoot, `${name.replaceAll('/', '__')}-`));
    try {
      await assembleModuleTree({
        cwd,
        name,
        pristineRoot: pristineDir,
        commit: entry.commit,
        gitUrl: entry.gitUrl,
        targetRoot: stage,
      });
    } catch (e) {
      await rm(stage, { recursive: true, force: true });
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push(`"${name}": ${err.message}`);
      continue;
    }

    if (existsSync(gitDir)) {
      try {
        const head = await runGitCapture(['rev-parse', 'HEAD'], { cwd: dest });
        const headNorm = head.toLowerCase();
        if (headNorm !== entry.commit.toLowerCase()) {
          errors.push(
            `"${name}": HEAD ${headNorm} does not match lock commit ${entry.commit.toLowerCase()}`,
          );
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(`"${name}": ${err.message}`);
      }

      try {
        const origin = await runGitCapture(['remote', 'get-url', 'origin'], { cwd: dest });
        if (!remotesEquivalent(origin, entry.gitUrl)) {
          errors.push(
            `"${name}": origin URL does not match lock (origin=${origin}, lock=${entry.gitUrl})`,
          );
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(`"${name}" remote check: ${err.message}`);
      }
    } else if (existsSync(markerPath)) {
      let marker: { commit: string; gitUrl: string } | null;
      try {
        marker = parseVendorMarker(await readFile(markerPath, 'utf8'));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(`"${name}": could not read ${VENDOR_MARKER}: ${err.message}`);
        continue;
      }
      if (!marker) {
        errors.push(`"${name}": invalid or empty ${VENDOR_MARKER}`);
        continue;
      }
      if (marker.commit !== entry.commit.toLowerCase()) {
        errors.push(
          `"${name}": vendor marker commit ${marker.commit} does not match lock ${entry.commit.toLowerCase()}`,
        );
      }
      if (!remotesEquivalent(marker.gitUrl, entry.gitUrl)) {
        errors.push(
          `"${name}": vendor marker gitUrl does not match lock (marker=${marker.gitUrl}, lock=${entry.gitUrl})`,
        );
      }
    } else {
      errors.push(
        `"${name}" has no .git and no ${VENDOR_MARKER} (re-run inrepo sync): ${dest}`,
      );
      await rm(stage, { recursive: true, force: true });
      continue;
    }

    try {
      const drift = await compareTrees(stage, dest);
      if (hasTreeDrift(drift)) {
        errors.push(formatTreeDrift(name, drift));
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
}
