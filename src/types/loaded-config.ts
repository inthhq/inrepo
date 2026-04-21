import type { InrepoPackage } from './inrepo-package.js';

export type LoadedConfig = {
  packages: InrepoPackage[];
  source: 'inrepo.json' | 'package.json';
};
