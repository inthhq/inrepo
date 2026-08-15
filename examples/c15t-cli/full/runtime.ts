import { access, readFile } from "node:fs/promises";
import nodePath from "node:path";

export const FULL_DIR = import.meta.dir;
export const FIXTURE_DIR = nodePath.join(FULL_DIR, "vendor");
export const RUNTIME_PATH_FILE = nodePath.join(FULL_DIR, ".runtime-path");

export const runtimeDir = async function runtimeDir(): Promise<string> {
  const value = await (await readFile(RUNTIME_PATH_FILE, "utf-8")).trim();
  if (value === "") {
    throw new Error(`Empty ${RUNTIME_PATH_FILE}; run npm run full:prepare`);
  }
  return value;
};

export const assertNoNodeModulesFallback =
  async function assertNoNodeModulesFallback(entry: string): Promise<void> {
    let cursor = nodePath.dirname(entry);
    const { root } = nodePath.parse(cursor);
    while (true) {
      try {
        await access(nodePath.join(cursor, "node_modules"));
        throw new Error(
          `Candidate could fall back to node_modules at ${nodePath.join(cursor, "node_modules")}`
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Candidate could")
        ) {
          throw error;
        }
      }
      if (cursor === root) {
        break;
      }
      cursor = nodePath.dirname(cursor);
    }
  };
