import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import nodePath from "node:path";

import {
  isLoadConfigNotFoundError,
  loadConfig,
} from "../config/load-config.js";
import { verifyLockGraphIssues } from "../deps/verify-lock-graph.js";
import { runGitCapture } from "../git/run-git-capture.js";
import { isJsonObject, isString } from "../json/unknown.js";
import { readLockfile } from "../lockfile/read-lockfile.js";
import { assembleModuleTree } from "../overlay/assemble-module.js";
import { ensurePristine } from "../overlay/cache.js";
import { compareTrees } from "../overlay/compare-trees.js";
import type { CompareTreesResult } from "../overlay/compare-trees.js";
import { readPackageManifest } from "../package-json/read-package-manifest.js";
import { moduleDestPath } from "../paths/module-dest-path.js";
import { normalizeGithubHttpsUrl } from "../registry/normalize-github-https-url.js";
import type { LockGraph } from "../types/lock-graph.js";
import type {
  VerifyIssue,
  VerifyIssueKind,
  VerifyResult,
} from "../types/verify-result.js";

const VENDOR_MARKER = ".inrepo-vendor.json";

const remotesEquivalent = function remotesEquivalent(
  a: string,
  b: string
): boolean {
  const na =
    normalizeGithubHttpsUrl(a) ?? a.replace(/\.git$/iu, "").toLowerCase();
  const nb =
    normalizeGithubHttpsUrl(b) ?? b.replace(/\.git$/iu, "").toLowerCase();
  return na === nb;
};

const parseVendorMarker = function parseVendorMarker(raw: string): {
  commit: string;
  gitUrl: string;
  repositoryDirectory: string | null;
} | null {
  let data: unknown;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isJsonObject(data)) {
    return null;
  }
  const rec = data;
  const { commit } = rec;
  const { gitUrl } = rec;
  if (!isString(commit) || !isString(gitUrl)) {
    return null;
  }
  return {
    commit: commit.toLowerCase(),
    gitUrl,
    repositoryDirectory: isString(rec.repositoryDirectory)
      ? rec.repositoryDirectory
      : null,
  };
};

const mergedVendorExcludes = function mergedVendorExcludes(
  globalExclude: string[],
  pkg: { exclude?: string[] }
): string[] {
  return [...new Set([...globalExclude, ...(pkg.exclude ?? [])])];
};

const mergedVendorKeeps = function mergedVendorKeeps(
  globalKeep: string[],
  pkg: { keep?: string[] }
): string[] {
  return [...new Set([...globalKeep, ...(pkg.keep ?? [])])];
};

const hasTreeDrift = function hasTreeDrift(
  result: CompareTreesResult
): boolean {
  return (
    result.added.length > 0 ||
    result.modified.length > 0 ||
    result.removed.length > 0 ||
    result.typeChanges.length > 0
  );
};

const summarizePaths = function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 5);
  const suffix =
    paths.length > shown.length
      ? `, … (+${paths.length - shown.length} more)`
      : "";
  return shown.join(", ") + suffix;
};

const formatTreeDrift = function formatTreeDrift(
  name: string,
  result: CompareTreesResult
): string {
  const parts: string[] = [];
  if (result.added.length > 0) {
    parts.push(`unexpected: ${summarizePaths(result.added)}`);
  }
  if (result.modified.length > 0) {
    parts.push(`modified: ${summarizePaths(result.modified)}`);
  }
  if (result.removed.length > 0) {
    parts.push(`missing: ${summarizePaths(result.removed)}`);
  }
  if (result.typeChanges.length > 0) {
    parts.push(`type-changed: ${summarizePaths(result.typeChanges)}`);
  }
  return `"${name}": vendored tree does not match lockfile + overlay (${parts.join("; ")})`;
};

/**
 * Replay the recorded dependency graph offline: every input comes from
 * committed files (`inrepo.lock.json` plus the vendored checkouts), so the
 * graph check never reaches the npm registry.
 */
const collectGraphIssues = async function collectGraphIssues(
  cwd: string,
  graph: LockGraph,
  moduleNames: Set<string>
): Promise<VerifyIssue[]> {
  if (Object.keys(graph).length === 0) {
    return [];
  }
  const vendoredVersions = new Map<string, string | null>();
  for (const name of Object.keys(graph)) {
    const dest = moduleDestPath(cwd, name);
    if (!existsSync(dest)) {
      continue;
    }
    try {
      vendoredVersions.set(
        name,
        (await readPackageManifest(dest))?.version ?? null
      );
    } catch {
      vendoredVersions.set(name, null);
    }
  }
  const { modules } = await readLockfile(cwd);
  return verifyLockGraphIssues({
    graph,
    moduleNames,
    moduleSources: new Map(
      Object.entries(modules).map(([module, entry]) => [module, entry.source])
    ),
    vendoredVersions,
  }).map((issue) => ({
    kind: "graph",
    message: issue.message,
    module: issue.module,
  }));
};

const errorMessage = function errorMessage<E>(error: E): string {
  return error instanceof Error ? error.message : String(error);
};

const toResult = function toResult(issues: VerifyIssue[]): VerifyResult {
  return {
    errors: issues.map((issue) => issue.message),
    issues,
    ok: issues.length === 0,
  };
};

export const verifyLock = async function verifyLock(
  cwd: string
): Promise<VerifyResult> {
  const { modules, graph } = await readLockfile(cwd);
  const names = Object.keys(modules);
  if (names.length === 0) {
    return toResult([
      {
        kind: "empty-lockfile",
        message: "No modules in inrepo.lock.json (nothing to verify).",
        module: null,
      },
    ]);
  }

  let configPackages: {
    name: string;
    module?: string;
    exclude?: string[];
    keep?: string[];
  }[] = [];
  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  try {
    const cfg = await loadConfig(cwd);
    configPackages = cfg.packages;
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
  } catch (error) {
    if (!isLoadConfigNotFoundError(error)) {
      throw error;
    }
  }
  const configByName = new Map(
    configPackages.map((pkg) => [pkg.module ?? pkg.name, pkg] as const)
  );

  const issues: VerifyIssue[] = [];
  const verifyTmpRoot = nodePath.join(cwd, ".inrepo", "verify");
  await mkdir(verifyTmpRoot, { recursive: true });

  for (const name of names) {
    const report = (kind: VerifyIssueKind, message: string): void => {
      issues.push({ kind, message, module: name });
    };
    const entry = modules[name];
    const dest = moduleDestPath(cwd, name);
    if (!existsSync(dest)) {
      report("missing-directory", `Missing directory for "${name}": ${dest}`);
      continue;
    }
    const st = await stat(dest);
    if (!st.isDirectory()) {
      report(
        "not-a-directory",
        `Path for "${name}" is not a directory: ${dest}`
      );
      continue;
    }
    const gitDir = nodePath.join(dest, ".git");
    const markerPath = nodePath.join(dest, VENDOR_MARKER);
    const pkgConfig = configByName.get(name) ?? { name };
    const keepList = mergedVendorKeeps(globalKeep, pkgConfig);
    const excludeList = mergedVendorExcludes(globalExclude, pkgConfig);

    let pristineDir: string;
    try {
      const pristine = await ensurePristine({
        artifact: entry.artifact,
        commit: entry.commit,
        cwd,
        exclude: excludeList,
        gitUrl: entry.gitUrl,
        keep: keepList,
        name,
        ref: entry.ref,
        repositoryDirectory: entry.repositoryDirectory,
      });
      pristineDir = pristine.dir;
    } catch (error) {
      report("pristine-unavailable", `"${name}": ${errorMessage(error)}`);
      continue;
    }

    const stage = await mkdtemp(
      nodePath.join(verifyTmpRoot, `${name.replaceAll("/", "__")}-`)
    );
    try {
      await assembleModuleTree({
        commit: entry.commit,
        cwd,
        gitUrl: entry.gitUrl,
        name,
        pristineRoot: pristineDir,
        repositoryDirectory: entry.repositoryDirectory,
        targetRoot: stage,
      });
    } catch (error) {
      await rm(stage, { force: true, recursive: true });
      report("assemble-failed", `"${name}": ${errorMessage(error)}`);
      continue;
    }

    if (existsSync(gitDir)) {
      try {
        const head = await runGitCapture(["rev-parse", "HEAD"], { cwd: dest });
        const headNorm = head.toLowerCase();
        if (headNorm !== entry.commit.toLowerCase()) {
          report(
            "head-mismatch",
            `"${name}": HEAD ${headNorm} does not match lock commit ${entry.commit.toLowerCase()}`
          );
        }
      } catch (error) {
        report("git-check-failed", `"${name}": ${errorMessage(error)}`);
      }

      try {
        const origin = await runGitCapture(["remote", "get-url", "origin"], {
          cwd: dest,
        });
        if (!remotesEquivalent(origin, entry.gitUrl)) {
          report(
            "origin-mismatch",
            `"${name}": origin URL does not match lock (origin=${origin}, lock=${entry.gitUrl})`
          );
        }
      } catch (error) {
        report(
          "git-check-failed",
          `"${name}" remote check: ${errorMessage(error)}`
        );
      }
    } else if (existsSync(markerPath)) {
      let marker: {
        commit: string;
        gitUrl: string;
        repositoryDirectory: string | null;
      } | null;
      try {
        marker = parseVendorMarker(await readFile(markerPath, "utf-8"));
      } catch (error) {
        report(
          "marker-unreadable",
          `"${name}": could not read ${VENDOR_MARKER}: ${errorMessage(error)}`
        );
        await rm(stage, { force: true, recursive: true });
        continue;
      }
      if (!marker) {
        report(
          "marker-invalid",
          `"${name}": invalid or empty ${VENDOR_MARKER}`
        );
        await rm(stage, { force: true, recursive: true });
        continue;
      }
      if (marker.commit !== entry.commit.toLowerCase()) {
        report(
          "marker-commit-mismatch",
          `"${name}": vendor marker commit ${marker.commit} does not match lock ${entry.commit.toLowerCase()}`
        );
      }
      if (!remotesEquivalent(marker.gitUrl, entry.gitUrl)) {
        report(
          "marker-git-url-mismatch",
          `"${name}": vendor marker gitUrl does not match lock (marker=${marker.gitUrl}, lock=${entry.gitUrl})`
        );
      }
      if (marker.repositoryDirectory !== (entry.repositoryDirectory ?? null)) {
        report(
          "marker-repository-directory-mismatch",
          `"${name}": vendor marker repositoryDirectory does not match lock (marker=${marker.repositoryDirectory ?? "(root)"}, lock=${entry.repositoryDirectory ?? "(root)"})`
        );
      }
    } else {
      report(
        "marker-missing",
        `"${name}" has no .git and no ${VENDOR_MARKER} (re-run inrepo sync): ${dest}`
      );
      await rm(stage, { force: true, recursive: true });
      continue;
    }

    try {
      const drift = await compareTrees(stage, dest);
      if (hasTreeDrift(drift)) {
        issues.push({
          drift: {
            added: drift.added,
            modified: drift.modified,
            removed: drift.removed,
            typeChanges: drift.typeChanges,
          },
          kind: "tree-drift",
          message: formatTreeDrift(name, drift),
          module: name,
        });
      }
    } finally {
      await rm(stage, { force: true, recursive: true });
    }
  }

  issues.push(...(await collectGraphIssues(cwd, graph, new Set(names))));

  return toResult(issues);
};
