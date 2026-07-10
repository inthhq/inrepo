import type { LockModule } from '../types/lock-module.js';
import type { PackageJsonDependencyTarget } from '../types/inrepo-package.js';

export type AddArgs = {
  name: string;
  git?: string;
  ref?: string;
  save: boolean;
  packageJson?: PackageJsonDependencyTarget;
};

export type SyncArgs = {
  force: boolean;
};

export type PatchArgs = {
  name?: string;
};

export type PackageSpec = {
  name: string;
  git?: string;
  ref?: string;
  exclude?: string[];
  keep?: string[];
};

export type MaterializeOptions = {
  mode: 'sync' | 'add';
  force: boolean;
  lockEntry?: LockModule;
};

export type DispatchOpts = {
  force?: boolean;
  suppressBanners?: boolean;
};
