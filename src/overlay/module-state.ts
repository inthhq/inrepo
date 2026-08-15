import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { isJsonObject, isString } from "../json/unknown.js";
import { moduleStatePath } from "./overlay-paths.js";

export interface ModuleSyncState {
  overlayHash: string;
  moduleHash: string;
}

const parseState = function parseState(
  raw: string,
  path: string
): ModuleSyncState {
  let parsed: unknown;
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new Error(`Invalid module state in ${path}: ${err.message}`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid module state in ${path}: expected an object`);
  }
  const rec = parsed;
  if (!isString(rec.overlayHash) || !isString(rec.moduleHash)) {
    throw new TypeError(
      `Invalid module state in ${path}: missing required fields`
    );
  }
  return {
    moduleHash: rec.moduleHash,
    overlayHash: rec.overlayHash,
  };
};

export const readModuleState = async function readModuleState(
  cwd: string,
  name: string
): Promise<ModuleSyncState | null> {
  const path = moduleStatePath(cwd, name);
  if (!existsSync(path)) {
    return null;
  }
  return parseState(await readFile(path, "utf-8"), path);
};

export const writeModuleState = async function writeModuleState(
  cwd: string,
  name: string,
  state: ModuleSyncState
): Promise<void> {
  const path = moduleStatePath(cwd, name);
  await mkdir(nodePath.dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
};
