import type { LockModule } from '../types/lock-module.js';

export type AddArgs = {
  name: string;
  git?: string;
  ref?: string;
  save: boolean;
  dev: boolean;
};

export type SyncArgs = {
  force: boolean;
};

export type PatchArgs = {
  name?: string;
  /** Reason recorded as the patch subject; required for patch-series capture. */
  message?: string;
};

export type DiffArgs = {
  name?: string;
  /** Show a per-file `+/-` summary instead of the full unified diff. */
  stat: boolean;
};

export type MigrateArgs = {
  name: string;
};

export type PackageSpec = {
  name: string;
  git?: string;
  ref?: string;
  dev?: boolean;
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
