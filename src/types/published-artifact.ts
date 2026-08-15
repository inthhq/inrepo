/** Immutable npm package payload used to fill publish-only runtime files. */
export type PublishedArtifact = {
  /** Registry tarball URL recorded by the selected version manifest. */
  tarballUrl: string;
  /** Subresource integrity for the exact tarball bytes. */
  integrity: string;
};
