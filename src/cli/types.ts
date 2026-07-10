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
