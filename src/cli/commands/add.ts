import { existsSync } from 'node:fs';
import { ensureInrepoInitialized } from '../../config/ensure-inrepo-initialized.js';
import {
  isLoadConfigNotFoundError,
  loadConfig,
  loadGlobalExclude,
  loadGlobalKeep,
} from '../../config/load-config.js';
import { upsertInrepoJson, type InrepoJsonEntry } from '../../inrepo-json/upsert-inrepo-json.js';
import { upsertPackageJsonInrepo } from '../../inrepo-json/upsert-package-json-inrepo.js';
import { readLockfile } from '../../lockfile/read-lockfile.js';
import { inrepoConfigPath } from '../../paths/inrepo-config-path.js';
import { moduleDestPath } from '../../paths/module-dest-path.js';
import { parseAddArgs } from '../args.js';
import { printBanner } from '../rendering.js';
import type { AddArgs, DispatchOpts } from '../types.js';
import { cancel, confirm, intro, isCancel, outro, text } from '../ui.js';
import { materializePackage } from '../vendor.js';

export async function performAdd(
  cwd: string,
  args: AddArgs,
  opts: DispatchOpts = {},
): Promise<void> {
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
  let hasConfigEntry = false;
  const { modules } = await readLockfile(cwd);
  try {
    const cfg = await loadConfig(cwd);
    globalExclude = cfg.exclude;
    globalKeep = cfg.keep;
    const entry = cfg.packages.find((p) => p.name === args.name);
    hasConfigEntry = entry != null;
    pkgExclude = entry?.exclude;
    pkgKeep = entry?.keep;
  } catch (e) {
    if (!isLoadConfigNotFoundError(e)) throw e;
    globalExclude = await loadGlobalExclude(cwd);
    globalKeep = await loadGlobalKeep(cwd);
  }

  if (!opts.suppressBanners) intro(`inrepo add — ${args.name}${args.dev ? ' (dev)' : ''}`);

  await materializePackage(
    cwd,
    {
      name: args.name,
      git: args.git,
      ref: args.ref,
      dev: args.dev,
      exclude: pkgExclude,
      keep: pkgKeep,
    },
    globalExclude,
    globalKeep,
    {
      mode: 'add',
      force:
        !hasConfigEntry &&
        !modules[args.name] &&
        existsSync(moduleDestPath(cwd, args.name)),
      lockEntry: modules[args.name],
    },
  );

  if (args.save) {
    const entry: InrepoJsonEntry = {
      name: args.name,
      dev: args.dev,
    };
    if (args.git !== undefined && args.git !== '') {
      entry.git = args.git;
    }
    if (args.ref !== undefined && args.ref !== '') {
      entry.ref = args.ref;
    }
    if (existsSync(inrepoConfigPath(cwd))) {
      await upsertInrepoJson(cwd, entry);
    } else {
      await upsertPackageJsonInrepo(cwd, entry);
    }
  }

  if (!opts.suppressBanners) {
    outro(
      args.save
        ? `Recorded "${args.name}" in inrepo config.`
        : `Vendored "${args.name}" (not saved to config).`,
    );
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
    validate: (value) =>
      value == null || value.trim() === '' ? 'Package name is required' : undefined,
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

  if (!opts.suppressBanners) outro('Starting vendor checkout');

  const trimmedGit = typeof git === 'string' ? git.trim() : '';
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  return {
    name: (name as string).trim(),
    git: trimmedGit === '' ? undefined : trimmedGit,
    ref: trimmedRef === '' ? undefined : trimmedRef,
    dev: dev === true,
    save: true,
  };
}
