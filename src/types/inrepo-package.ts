export type InrepoPackage = {
  name: string;
  git?: string;
  ref?: string;
  /** When true, sync wires package.json#devDependencies instead of #dependencies. */
  dev?: boolean;
};
