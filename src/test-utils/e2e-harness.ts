import { readFile, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type { JsonObject } from "../json/unknown.js";

/** Where inrepo config lives in a given test scenario. */
export type ConfigMode = "inrepo.json" | "package.json";

/** All config locations the e2e suites should be parameterized over. */
export const MODES: ConfigMode[] = ["inrepo.json", "package.json"];

export interface CliTestEnv {
  INREPO_NONINTERACTIVE: "1";
  INREPO_CONFIG: ConfigMode;
  [key: string]: string | undefined;
}

/** Build an env map that runs the CLI non-interactively against a given config mode. */
export const envFor = function envFor(mode: ConfigMode): CliTestEnv {
  return { INREPO_CONFIG: mode, INREPO_NONINTERACTIVE: "1" };
};

/** Read a JSON file and return its parsed object. */
export const readJson = async function readJson(
  path: string
): Promise<JsonObject> {
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return JSON.parse(await readFile(path, "utf-8")) as JsonObject;
};

/**
 * Write the given inrepo config to whichever location `mode` selects.
 * For the `package.json` mode, the file must already exist (use {@link bootstrapHostPackageJson}).
 */
export const writeConfig = async function writeConfig(
  cwd: string,
  mode: ConfigMode,
  config: JsonObject
): Promise<void> {
  if (mode === "inrepo.json") {
    await writeFile(
      nodePath.join(cwd, "inrepo.json"),
      `${JSON.stringify(config)}\n`,
      "utf-8"
    );
    return;
  }
  const pkgPath = nodePath.join(cwd, "package.json");
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as JsonObject;
  pkg.inrepo = config;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
};

/** Read whichever config the mode selects, returning the inrepo subtree only. */
export const readConfig = async function readConfig(
  cwd: string,
  mode: ConfigMode
): Promise<JsonObject> {
  if (mode === "inrepo.json") {
    return readJson(nodePath.join(cwd, "inrepo.json"));
  }
  const pkg = await readJson(nodePath.join(cwd, "package.json"));
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return pkg.inrepo as JsonObject;
};

/** Write a minimal host `package.json` (no `inrepo` field) into the test cwd. */
export const bootstrapHostPackageJson = async function bootstrapHostPackageJson(
  cwd: string
): Promise<void> {
  await writeFile(
    nodePath.join(cwd, "package.json"),
    `${JSON.stringify({ name: "host", version: "0.0.0" }, null, 2)}\n`,
    "utf-8"
  );
};
