import type { PublishedArtifact } from './published-artifact.js';

export type LockModule = {
  source: string;
  gitUrl: string;
  /** Package root within the repository; omitted for the repository root. */
  repositoryDirectory?: string;
  commit: string;
  ref: string | null;
  /** Published npm payload paired with this git pin, when registry metadata supplied one. */
  artifact?: PublishedArtifact;
  updatedAt: string;
};
