import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

import { SERIES_DIR_NAME } from "./overlay-paths.js";
import { copyEntry, copyTree, relPosixToAbs, walkTree } from "./tree-utils.js";

const skipOverlayControlFile = function skipOverlayControlFile(
  relPosix: string
): boolean {
  return (
    relPosix === ".inrepo-deletions" ||
    relPosix === SERIES_DIR_NAME ||
    relPosix.startsWith(`${SERIES_DIR_NAME}/`)
  );
};

export const applyOverlay = async function applyOverlay(opts: {
  pristineRoot: string;
  overlayRoot: string;
  deletions: string[];
  targetRoot: string;
}): Promise<string> {
  await rm(opts.targetRoot, { force: true, recursive: true });
  await mkdir(opts.targetRoot, { recursive: true });

  await copyTree(opts.pristineRoot, opts.targetRoot, {
    treatMissingAsEmpty: true,
  });

  if (existsSync(opts.overlayRoot)) {
    const overlayEntries = await walkTree(opts.overlayRoot, {
      skip: skipOverlayControlFile,
      treatMissingAsEmpty: true,
    });
    for (const relPosix of [...overlayEntries.keys()].toSorted()) {
      await copyEntry(opts.overlayRoot, relPosix, opts.targetRoot, {
        validateSymlinkWithinRoot: true,
      });
    }
  }

  for (const relPosix of opts.deletions) {
    const body = relPosix.endsWith("/") ? relPosix.slice(0, -1) : relPosix;
    await rm(relPosixToAbs(opts.targetRoot, body), {
      force: true,
      recursive: true,
    });
  }

  return opts.targetRoot;
};
