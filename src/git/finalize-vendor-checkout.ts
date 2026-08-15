import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

const VENDOR_MARKER = ".inrepo-vendor.json";

interface VendorMarker {
  commit: string;
  gitUrl: string;
  repositoryDirectory?: string | null;
}

/**
 * Persist lock-compatible metadata and remove `.git` so `inrepo_modules` holds plain files only.
 */
export const finalizeVendorCheckout = async function finalizeVendorCheckout(
  dest: string,
  meta: { commit: string; gitUrl: string; repositoryDirectory?: string | null }
): Promise<void> {
  const marker: VendorMarker = {
    commit: meta.commit,
    gitUrl: meta.gitUrl,
  };
  if (meta.repositoryDirectory != null) {
    marker.repositoryDirectory = meta.repositoryDirectory;
  }
  await writeFile(
    nodePath.join(dest, VENDOR_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf-8"
  );
  const gitMeta = nodePath.join(dest, ".git");
  if (existsSync(gitMeta)) {
    await rm(gitMeta, { force: true, recursive: true });
  }
};
