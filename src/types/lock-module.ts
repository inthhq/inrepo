export type LockModule = {
  source: string;
  gitUrl: string;
  /** Package root within the repository; omitted for the repository root. */
  repositoryDirectory?: string;
  commit: string;
  ref: string | null;
  updatedAt: string;
};
