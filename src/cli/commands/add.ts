import { existsSync } from 'node:fs';
import { ensureInrepoInitialized } from '../../config/ensure-inrepo-initialized.js';
import { isLoadConfigNotFoundError, loadConfig, loadGlobalExclude, loadGlobalKeep } from '../../config/load-config.js';
import { buildLockGraph } from '../../deps/build-lock-graph.js';
import { renderDependencyTree } from '../../deps/render-dependency-tree.js';
import { orderByDependencies } from '../../deps/vendored-graph.js';
import { upsertInrepoJson, type InrepoJsonEntry } from '../../inrepo-json/upsert-inrepo-json.js';
import { upsertPackageJsonInrepo } from '../../inrepo-json/upsert-package-json-inrepo.js';
import { upsertLockGraph } from '../../lockfile/upsert-lock-graph.js';
import { readLockfile } from '../../lockfile/read-lockfile.js';
import { inrepoConfigPath } from '../../paths/inrepo-config-path.js';
import { moduleDestPath } from '../../paths/module-dest-path.js';
import type { InrepoPackage } from '../../types/inrepo-package.js';
import { parseAddArgs } from '../args.js';
import { printBanner } from '../rendering.js';
import type { AddArgs, DispatchOpts } from '../types.js';
import { cancel, confirm, intro, isCancel, outro, text, ui } from '../ui.js';
import { materializePackage } from '../vendor.js';
import {
  dependencySpec,
  planWithDeps,
  preflightWithDeps,
  resolveExistingRootPin,
  type WithDepsPlan,
} from '../with-deps.js';

/** Persist a package entry to whichever config location the project uses. */
async function saveConfigEntry(cwd: string, entry: InrepoJsonEntry): Promise<void> {
  if (existsSync(inrepoConfigPath(cwd))) {
    await upsertInrepoJson(cwd, entry);
  } else {
    await upsertPackageJsonInrepo(cwd, entry);
  }
}

/**
 * Vendor the resolved dependencies, deepest first.
 *
 * The recorded graph is written before any of them is materialized, and the
 * order follows it, so a package that opted into import rewiring always finds
 * its dependencies' checkouts already in place.
 */
async function vendorPlannedDependencies(
  cwd: string,
  plan: WithDepsPlan,
  ctx: {
    dev: boolean;
    globalExclude: string[];
    globalKeep: string[];
    configByName: Map<string, InrepoPackage>;
  },
): Promise<void> {
  const graph = buildLockGraph(plan.graph);
  await upsertLockGraph(cwd, graph);

  // Config entries are recorded in resolution order, which is what the user
  // reads; vendoring then follows dependency order, which is what the generated
  // transforms need.
  for (const node of plan.pending) {
    await saveConfigEntry(cwd, {
      name: node.name,
      git: node.gitUrl,
      ...(node.repositoryDirectory == null ? {} : { repositoryDirectory: node.repositoryDirectory }),
      ...(node.ref == null ? {} : { ref: node.ref }),
      dev: ctx.dev,
    });
  }

  const { modules } = await readLockfile(cwd);
  for (const node of orderByDependencies(plan.pending, graph)) {
    const config = ctx.configByName.get(node.name);
    const spec = dependencySpec(node, ctx.dev, config);
    await materializePackage(cwd, spec, ctx.globalExclude, ctx.globalKeep, {
      mode: 'add',
      force: config == null && !modules[node.name] && existsSync(moduleDestPath(cwd, node.name)),
      lockEntry: modules[node.name],
      resolvedCommit: node.commit,
    });
  }
}

export async function performAdd(cwd: string, args: AddArgs, opts: DispatchOpts = {}): Promise<void> {
  if (!opts.suppressBanners) printBanner();
  // First-time setup is only required when we're going to persist the entry.
  // `--no-save` is an explicit one-off vendor operation.
  if (args.save) {
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
    for (const pkg of cfg.packages) configByName.set(pkg.name, pkg);
    const entry = configByName.get(args.name);
    hasConfigEntry = entry != null;
    pkgExclude = entry?.exclude;
    pkgKeep = entry?.keep;
    pkgRepositoryDirectory = args.repositoryDirectory ?? entry?.repositoryDirectory;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  if (!opts.suppressBanners) intro(`inrepo add — ${args.name}${args.dev ? ' (dev)' : ''}`);

  const lockEntry = modules[args.name];
  const configEntry = configByName.get(args.name);
  const pin = resolveExistingRootPin(args, {
    gitUrl: configEntry?.git ?? lockEntry?.gitUrl,
    ref: configEntry?.ref ?? lockEntry?.ref,
    commit: lockEntry?.commit,
  });

  // Resolving the whole closure first means a conflict or an unsupported
  // dependency source fails before any package is vendored.
  let plan: WithDepsPlan | null = null;
  if (args.withDeps) {
    plan = await planWithDeps(cwd, {
      root: {
        name: args.name,
        git: pin.git,
        repositoryDirectory: pkgRepositoryDirectory,
        ref: pin.ref,
        commit: pin.commit,
        dev: args.dev,
        exclude: pkgExclude,
        keep: pkgKeep,
      },
      globalExclude,
      globalKeep,
    });
    ui.note(renderDependencyTree(plan.graph), `Dependency graph — ${plan.graph.nodes.length} package(s)`);
    await preflightWithDeps(cwd, plan, {
      dev: args.dev,
      globalExclude,
      globalKeep,
      configByName,
    });
  }

  const rootEntry: InrepoJsonEntry | null = args.save ? { name: args.name, dev: args.dev } : null;
  if (rootEntry) {
    if (args.git !== undefined && args.git !== '') {
      rootEntry.git = args.git;
    }
    if (args.ref !== undefined && args.ref !== '') {
      rootEntry.ref = args.ref;
    }
    const plannedRoot = plan?.graph.nodes.find((node) => node.root);
    const repositoryDirectory = args.repositoryDirectory ?? plannedRoot?.repositoryDirectory ?? pkgRepositoryDirectory;
    if (repositoryDirectory != null) rootEntry.repositoryDirectory = repositoryDirectory;
  }

  const vendorRoot = (): Promise<void> =>
    materializePackage(
      cwd,
      {
        name: args.name,
        git: pin.git,
        repositoryDirectory:
          args.repositoryDirectory ??
          plan?.graph.nodes.find((node) => node.root)?.repositoryDirectory ??
          pkgRepositoryDirectory,
        ref: pin.ref,
        commit: pin.commit,
        dev: args.dev,
        exclude: pkgExclude,
        keep: pkgKeep,
      },
      globalExclude,
      globalKeep,
      {
        mode: 'add',
        force: !hasConfigEntry && !modules[args.name] && existsSync(moduleDestPath(cwd, args.name)),
        lockEntry: modules[args.name],
        resolvedCommit: plan?.graph.nodes.find((node) => node.root)?.commit,
      },
    );

  if (plan) {
    // The root is vendored last so that import rewiring finds every dependency
    // checkout already in place. Its config entry is written first so the
    // recorded `packages` list still starts with the package the user named.
    if (rootEntry) await saveConfigEntry(cwd, rootEntry);
    await vendorPlannedDependencies(cwd, plan, {
      dev: args.dev,
      globalExclude,
      globalKeep,
      configByName,
    });
    await vendorRoot();
  } else {
    await vendorRoot();
    if (rootEntry) {
      const lockEntry = (await readLockfile(cwd)).modules[args.name];
      if (lockEntry?.repositoryDirectory != null) {
        rootEntry.repositoryDirectory = lockEntry.repositoryDirectory;
      }
      await saveConfigEntry(cwd, rootEntry);
    }
  }

  if (!opts.suppressBanners) {
    if (plan) {
      const reused = plan.reused.length;
      outro(
        `Vendored ${plan.pending.length + 1} package(s) for "${args.name}"` +
          `${reused > 0 ? `; ${reused} already vendored` : ''}.`,
      );
      return;
    }
    outro(args.save ? `Recorded "${args.name}" in inrepo config.` : `Vendored "${args.name}" (not saved to config).`);
  }
}

export async function cmdAdd(cwd: string, argv: string[]): Promise<void> {
  await performAdd(cwd, parseAddArgs(argv));
}

/**
 * Drive the four `add` inputs through Clack prompts. Returns null if the user
 * cancels at any point.
 */
export async function promptAddArgs(opts: DispatchOpts = {}): Promise<AddArgs | null> {
  if (!opts.suppressBanners) intro('inrepo add');

  const onCancel = (): null => {
    if (!opts.suppressBanners) cancel('Cancelled.');
    return null;
  };

  const name = await text({
    message: 'Package name',
    placeholder: 'e.g. lodash or @scope/pkg',
    validate: (value) => (value == null || value.trim() === '' ? 'Package name is required' : undefined),
  });
  if (isCancel(name)) return onCancel();

  const git = await text({
    message: 'Git URL (optional)',
    placeholder: 'leave blank to resolve from npm registry',
  });
  if (isCancel(git)) return onCancel();

  const ref = await text({
    message: 'Ref (branch / tag / SHA, optional)',
    placeholder: 'leave blank for default branch',
  });
  if (isCancel(ref)) return onCancel();

  const dev = await confirm({
    message: 'Save under devDependencies?',
    initialValue: false,
  });
  if (isCancel(dev)) return onCancel();

  const withDeps = await confirm({
    message: 'Also vendor its runtime dependencies?',
    initialValue: false,
  });
  if (isCancel(withDeps)) return onCancel();

  if (!opts.suppressBanners) outro('Starting vendor checkout');

  const trimmedGit = typeof git === 'string' ? git.trim() : '';
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  return {
    name: (name as string).trim(),
    git: trimmedGit === '' ? undefined : trimmedGit,
    ref: trimmedRef === '' ? undefined : trimmedRef,
    dev: dev === true,
    save: true,
    withDeps: withDeps === true,
  };
}
