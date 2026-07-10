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
import {
  preflightRootPackageJsonDependencyLinks,
  syncRootPackageJsonDependencies,
  type PackageJsonDependencyLink,
} from '../../package-json/upsert-vendored-package-ref.js';
import { inrepoConfigPath } from '../../paths/inrepo-config-path.js';
import { moduleDestPath } from '../../paths/module-dest-path.js';
import type { PackageJsonDependencyTarget } from '../../types/inrepo-package.js';
import { parseAddArgs } from '../args.js';
import { printBanner } from '../rendering.js';
import type { AddArgs, DispatchOpts } from '../types.js';
import { cancel, intro, isCancel, outro, select, text } from '../ui.js';
import { materializePackage } from '../vendor.js';

export type AddPackageJsonChoice = PackageJsonDependencyTarget | 'none';

export const DEFAULT_ADD_PACKAGE_JSON_CHOICE: AddPackageJsonChoice = 'none';

export const ADD_PACKAGE_JSON_CHOICES: {
  value: AddPackageJsonChoice;
  label: string;
  hint?: string;
}[] = [
  { value: 'none', label: 'Do not link', hint: 'source vendoring only' },
  { value: 'dependencies', label: 'dependencies' },
  { value: 'devDependencies', label: 'devDependencies' },
];

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

  const packageJsonLinks: PackageJsonDependencyLink[] = args.packageJson
    ? [{ name: args.name, target: args.packageJson }]
    : [];
  await preflightRootPackageJsonDependencyLinks(cwd, packageJsonLinks);

  if (!opts.suppressBanners) {
    const linkLabel = args.packageJson ? ` (${args.packageJson})` : '';
    intro(`inrepo add — ${args.name}${linkLabel}`);
  }

  await materializePackage(
    cwd,
    {
      name: args.name,
      git: args.git,
      ref: args.ref,
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
      packageJson: args.packageJson,
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

  await syncRootPackageJsonDependencies(cwd, packageJsonLinks);

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
 * Drive the `add` inputs through Hexbus prompts. Returns null if the user
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

  const packageJson = await select<AddPackageJsonChoice>({
    message: 'Link the generated package in package.json?',
    initialValue: DEFAULT_ADD_PACKAGE_JSON_CHOICE,
    options: ADD_PACKAGE_JSON_CHOICES,
  });
  if (isCancel(packageJson)) return onCancel();

  if (!opts.suppressBanners) outro('Starting vendor checkout');

  const trimmedGit = typeof git === 'string' ? git.trim() : '';
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  return {
    name: (name as string).trim(),
    git: trimmedGit === '' ? undefined : trimmedGit,
    ref: trimmedRef === '' ? undefined : trimmedRef,
    packageJson: packageJson === 'none' ? undefined : packageJson,
    save: true,
  };
}
