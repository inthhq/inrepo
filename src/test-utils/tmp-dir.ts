import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

export const makeTmpDir = function makeTmpDir(
  prefix = "inrepo-test-"
): Promise<string> {
  const base = realpathSync(tmpdir());
  return mkdtemp(nodePath.join(base, prefix));
};

export const cleanupTmpDir = async function cleanupTmpDir(
  dir: string | undefined
): Promise<void> {
  if (!dir) {
    return;
  }
  await rm(dir, { force: true, recursive: true });
};
