import { existsSync } from "node:fs";

import { ensureInrepoInitialized } from "../../config/ensure-inrepo-initialized.js";
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from "../../config/load-config.js";
import { buildLockGraph } from "../../deps/build-lock-graph.js";
import { renderDependencyTree } from "../../deps/render-dependency-tree.js";
import type { ResolvedNode } from "../../deps/resolve-dependency-graph.js";
import { orderByDependencies } from "../../deps/vendored-graph.js";
import { upsertInrepoJson } from "../../inrepo-json/upsert-inrepo-json.js";
import type { InrepoJsonEntry } from "../../inrepo-json/upsert-inrepo-json.js";
import { upsertPackageJsonInrepo } from "../../inrepo-json/upsert-package-json-inrepo.js";
import { isString } from "../../json/unknown.js";
import { readLockfile } from "../../lockfile/read-lockfile.js";
import { upsertLockGraph } from "../../lockfile/upsert-lock-graph.js";
import { inrepoConfigPath } from "../../paths/inrepo-config-path.js";
import { moduleDestPath } from "../../paths/module-dest-path.js";
import type { InrepoPackage } from "../../types/inrepo-package.js";
import { parseAddArgs } from "../args.js";
import { isDryRun } from "../output.js";
import { printBanner } from "../rendering.js";
import type {
  AddArgs,
  DispatchOpts,
  MaterializeOptions,
  PackageSpec,
} from "../types.js";
import { cancel, confirm, intro, isCancel, outro, text, ui } from "../ui.js";
import {
  countSeriesPatches,
  materializePackage,
  planMaterialize,
} from "../vendor.js";
import type { MaterializeResult } from "../vendor.js";
import {
  dependencySpec,
  planWithDeps,
  preflightWithDeps,
  resolveExistingRootPin,
} from "../with-deps.js";
import type { WithDepsPlan } from "../with-deps.js";

export type { MaterializeAction, MaterializeResult } from "../vendor.js";

export interface AddedPackage extends MaterializeResult {
  /** Linked under devDependencies rather than dependencies. */
  dev: boolean;
}

export interface AddResult {
  /** The package named on the command line. */
  package: AddedPackage;
  /** Whether the package is (or, under --dry-run, would be) recorded in config. */
  saved: boolean;
  /**
   * `--with-deps` only: every dependency in the resolved closure, in
   * resolution order. Already-satisfied pins have action `reused`.
   */
  dependencies?: MaterializeResult[];
}

/** Report a dependency an existing vendored pin already satisfied. */
const reusedResult = async function reusedResult(
  cwd: string,
  node: ResolvedNode
): Promise<MaterializeResult> {
  const path = moduleDestPath(cwd, node.module);
  return {
    action: "reused",
    backup: null,
    commit: node.commit,
    git: node.gitUrl,
    module: node.module,
    name: node.name,
    patches: await countSeriesPatches(cwd, node.module),
    path: `inrepo_modules/${node.module}`,
    previousCommit: existsSync(path) ? node.commit : null,
    ref: node.ref,
    repositoryDirectory: node.repositoryDirectory,
  };
};

/** Dependency results in plan (resolution) order: vendored or reused. */
const dependencyResults = async function dependencyResults(
  cwd: string,
  plan: WithDepsPlan,
  vendored: Map<string, MaterializeResult>
): Promise<MaterializeResult[]> {
  const results: MaterializeResult[] = [];
  for (const node of plan.graph.nodes) {
    if (node.root) {
      continue;
    }
    const done = vendored.get(node.module);
    results.push(done ?? (await reusedResult(cwd, node)));
  }
  return results;
};

/** Persist a package entry to whichever config location the project uses. */
const saveConfigEntry = async function saveConfigEntry(
  cwd: string,
  entry: InrepoJsonEntry
): Promise<void> {
  await (existsSync(inrepoConfigPath(cwd))
    ? upsertInrepoJson(cwd, entry)
    : upsertPackageJsonInrepo(cwd, entry));
};

const dependencyMaterializeOptions = function dependencyMaterializeOptions(
  cwd: string,
  node: ResolvedNode,
  modules: Awaited<ReturnType<typeof readLockfile>>["modules"],
  config: InrepoPackage | undefined
): MaterializeOptions {
  return {
    force:
      config == null &&
      !modules[node.module] &&
      existsSync(moduleDestPath(cwd, node.module)),
    lockEntry: modules[node.module],
    mode: "add",
    resolvedCommit: node.commit,
  };
};

/** `--dry-run` preview of {@link vendorPlannedDependencies}; writes nothing. */
const planPlannedDependencies = async function planPlannedDependencies(
  cwd: string,
  plan: WithDepsPlan,
  ctx: { dev: boolean; configByName: Map<string, InrepoPackage> }
): Promise<Map<string, MaterializeResult>> {
  const { modules } = await readLockfile(cwd);
  const results = new Map<string, MaterializeResult>();
  for (const node of plan.pending) {
    const config = ctx.configByName.get(node.module);
    results.set(
      node.module,
      await planMaterialize(
        cwd,
        dependencySpec(node, ctx.dev, config),
        dependencyMaterializeOptions(cwd, node, modules, config)
      )
    );
  }
  return results;
};

/**
 * Vendor the resolved dependencies, deepest first.
 *
 * The recorded graph is written before any of them is materialized, and the
 * order follows it, so a package that opted into import rewiring always finds
 * its dependencies' checkouts already in place.
 */
const vendorPlannedDependencies = async function vendorPlannedDependencies(
  cwd: string,
  plan: WithDepsPlan,
  ctx: {
    dev: boolean;
    globalExclude: string[];
    globalKeep: string[];
    configByName: Map<string, InrepoPackage>;
  }
): Promise<Map<string, MaterializeResult>> {
  const graph = buildLockGraph(plan.graph);
  await upsertLockGraph(cwd, graph);

  // Config entries are recorded in resolution order, which is what the user
  // reads; vendoring then follows dependency order, which is what the generated
  // transforms need.
  for (const node of plan.pending) {
    const entry: InrepoJsonEntry = {
      dev: ctx.dev,
      git: node.gitUrl,
      module: node.module,
      name: node.name,
    };
    if (node.repositoryDirectory != null) {
      entry.repositoryDirectory = node.repositoryDirectory;
    }
    if (node.ref != null) {
      entry.ref = node.ref;
    }
    await saveConfigEntry(cwd, entry);
  }

  const { modules } = await readLockfile(cwd);
  const results = new Map<string, MaterializeResult>();
  for (const node of orderByDependencies(plan.pending, graph)) {
    const config = ctx.configByName.get(node.module);
    const spec = dependencySpec(node, ctx.dev, config);
    results.set(
      node.module,
      await materializePackage(
        cwd,
        spec,
        ctx.globalExclude,
        ctx.globalKeep,
        dependencyMaterializeOptions(cwd, node, modules, config)
      )
    );
  }
  return results;
};

/**
 * Vendor (or refresh) one package and record it in config.
 *
 * Under the global `--dry-run`, resolves the same pin and dependency plan but
 * writes no config, lockfile, package.json, or `inrepo_modules/` checkout.
 * Only `--with-deps` touches the `.inrepo/` cache, because resolving the
 * closure needs the root's manifest at the pinned commit.
 */
export const performAdd = async function performAdd(
  cwd: string,
  args: AddArgs,
  opts: DispatchOpts = {}
): Promise<AddResult> {
  const dryRun = isDryRun();
  if (!opts.suppressBanners) {
    printBanner();
  }
  // First-time setup is only required when we're going to persist the entry.
  // `--no-save` is an explicit one-off vendor operation; a dry run writes nothing.
  if (args.save && !dryRun) {
    await ensureInrepoInitialized(cwd);
  }

  let globalExclude: string[] = [];
  let globalKeep: string[] = [];
  let pkgExclude: string[] | undefined;
  let pkgKeep: string[] | undefined;
  let pkgRepositoryDirectory: string | undefined;
  let hasConfigEntry = false;
  const configByName = new Map<string, InrepoPackage>();
  const { modules } = await readLockfile(cwd);
  try {
    const cfg = await loadConfig(cwd);
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
    for (const pkg of cfg.packages) {
      configByName.set(pkg.module ?? pkg.name, pkg);
    }
    const entry = configByName.get(args.name);
    hasConfigEntry = entry != null;
    pkgExclude = entry?.exclude;
    pkgKeep = entry?.keep;
    pkgRepositoryDirectory =
      args.repositoryDirectory ?? entry?.repositoryDirectory;
  } catch (error) {
    if (!isLoadConfigNotFoundError(error)) {
      throw error;
    }
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  if (!opts.suppressBanners) {
    intro(
      `inrepo add${dryRun ? " (dry run)" : ""} — ${args.name}${args.dev ? " (dev)" : ""}`
    );
  }

  const lockEntry = modules[args.name];
  const configEntry = configByName.get(args.name);
  const pin = resolveExistingRootPin(args, {
    commit: lockEntry?.commit,
    gitUrl: configEntry?.git ?? lockEntry?.gitUrl,
    ref: configEntry?.ref ?? lockEntry?.ref,
  });

  // Resolving the whole closure first means a conflict or an unsupported
  // dependency source fails before any package is vendored.
  let plan: WithDepsPlan | null = null;
  if (args.withDeps) {
    plan = await planWithDeps(cwd, {
      globalExclude,
      globalKeep,
      root: {
        // Only the caller's --git/--ref. A lock pin is applied inside
        // planWithDeps; stuffing it into `git` would look like an explicit
        // manual source and switch the root onto checkout workspace: ranges.
        commit: pin.commit,
        dev: args.dev,
        exclude: pkgExclude,
        git: args.git,
        keep: pkgKeep,
        name: args.name,
        ref: args.ref,
        repositoryDirectory:
          pkgRepositoryDirectory ?? lockEntry?.repositoryDirectory,
      },
    });
    ui.note(
      renderDependencyTree(plan.graph),
      `Dependency graph — ${plan.graph.nodes.length} package(s)`
    );
    await preflightWithDeps(cwd, plan, {
      configByName,
      dev: args.dev,
      globalExclude,
      globalKeep,
    });
  }

  const plannedRoot = plan?.graph.nodes.find((node) => node.root);
  const rootEntry: InrepoJsonEntry | null = args.save
    ? { dev: args.dev, name: args.name }
    : null;
  if (rootEntry) {
    if (args.git !== undefined && args.git !== "") {
      rootEntry.git = args.git;
    }
    if (args.ref !== undefined && args.ref !== "") {
      rootEntry.ref = args.ref;
    }
    const repositoryDirectory =
      args.repositoryDirectory ??
      plannedRoot?.repositoryDirectory ??
      pkgRepositoryDirectory;
    if (repositoryDirectory != null) {
      rootEntry.repositoryDirectory = repositoryDirectory;
    }
  }

  const rootSpec: PackageSpec = {
    commit: pin.commit,
    dev: args.dev,
    exclude: pkgExclude,
    git: pin.git,
    keep: pkgKeep,
    name: args.name,
    ref: pin.ref,
    repositoryDirectory:
      args.repositoryDirectory ??
      plannedRoot?.repositoryDirectory ??
      pkgRepositoryDirectory,
  };
  const rootOpts: MaterializeOptions = {
    force:
      !hasConfigEntry &&
      !modules[args.name] &&
      existsSync(moduleDestPath(cwd, args.name)),
    lockEntry: modules[args.name],
    mode: "add",
    resolvedCommit: plannedRoot?.commit,
  };
  const vendorRoot = (): Promise<MaterializeResult> =>
    materializePackage(cwd, rootSpec, globalExclude, globalKeep, rootOpts);

  let root: MaterializeResult;
  let vendored = new Map<string, MaterializeResult>();
  if (dryRun) {
    if (plan) {
      vendored = await planPlannedDependencies(cwd, plan, {
        configByName,
        dev: args.dev,
      });
    }
    root = await planMaterialize(cwd, rootSpec, rootOpts);
  } else if (plan) {
    // The root is vendored last so that import rewiring finds every dependency
    // checkout already in place. Its config entry is written first so the
    // recorded `packages` list still starts with the package the user named.
    if (rootEntry) {
      await saveConfigEntry(cwd, rootEntry);
    }
    vendored = await vendorPlannedDependencies(cwd, plan, {
      configByName,
      dev: args.dev,
      globalExclude,
      globalKeep,
    });
    root = await vendorRoot();
  } else {
    root = await vendorRoot();
    if (rootEntry) {
      const { modules: updatedModules } = await readLockfile(cwd);
      const updatedLockEntry = updatedModules[args.name];
      if (updatedLockEntry?.repositoryDirectory != null) {
        rootEntry.repositoryDirectory = updatedLockEntry.repositoryDirectory;
      }
      await saveConfigEntry(cwd, rootEntry);
    }
  }

  const result: AddResult = {
    package: { ...root, dev: args.dev },
    saved: args.save,
  };
  if (plan) {
    result.dependencies = await dependencyResults(cwd, plan, vendored);
  }

  if (!opts.suppressBanners) {
    if (dryRun) {
      const count = plan ? plan.pending.length + 1 : 1;
      outro(
        `Dry run — no files written. Would vendor ${count} package(s) for "${args.name}" @ ${root.commit.slice(0, 7)}` +
          `${args.save ? " and record it in inrepo config" : ""}.`
      );
    } else if (plan) {
      const reused = plan.reused.length;
      outro(
        `Vendored ${plan.pending.length + 1} package(s) for "${args.name}"` +
          `${reused > 0 ? `; ${reused} already vendored` : ""}.`
      );
    } else {
      outro(
        args.save
          ? `Recorded "${args.name}" in inrepo config.`
          : `Vendored "${args.name}" (not saved to config).`
      );
    }
  }
  return result;
};

export const cmdAdd = function cmdAdd(
  cwd: string,
  argv: string[]
): Promise<AddResult> {
  return performAdd(cwd, parseAddArgs(argv));
};

/**
 * Drive the four `add` inputs through Clack prompts. Returns null if the user
 * cancels at any point.
 */
export const promptAddArgs = async function promptAddArgs(
  opts: DispatchOpts = {}
): Promise<AddArgs | null> {
  if (!opts.suppressBanners) {
    intro("inrepo add");
  }

  const onCancel = (): null => {
    if (!opts.suppressBanners) {
      cancel("Cancelled.");
    }
    return null;
  };

  const name = await text({
    message: "Package name",
    placeholder: "e.g. lodash or @scope/pkg",
    validate: (value) =>
      value == null || value.trim() === ""
        ? "Package name is required"
        : undefined,
  });
  if (isCancel(name)) {
    return onCancel();
  }

  const git = await text({
    message: "Git URL (optional)",
    placeholder: "leave blank to resolve from npm registry",
  });
  if (isCancel(git)) {
    return onCancel();
  }

  const ref = await text({
    message: "Ref (branch / tag / SHA, optional)",
    placeholder: "leave blank for default branch",
  });
  if (isCancel(ref)) {
    return onCancel();
  }

  const dev = await confirm({
    initialValue: false,
    message: "Save under devDependencies?",
  });
  if (isCancel(dev)) {
    return onCancel();
  }

  const withDeps = await confirm({
    initialValue: false,
    message: "Also vendor its runtime dependencies?",
  });
  if (isCancel(withDeps)) {
    return onCancel();
  }

  if (!opts.suppressBanners) {
    outro("Starting vendor checkout");
  }

  const trimmedGit = isString(git) ? git.trim() : "";
  const trimmedRef = isString(ref) ? ref.trim() : "";
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return {
    dev: dev === true,
    git: trimmedGit === "" ? undefined : trimmedGit,
    name: (name as string).trim(),
    ref: trimmedRef === "" ? undefined : trimmedRef,
    save: true,
    withDeps: withDeps === true,
  };
};
