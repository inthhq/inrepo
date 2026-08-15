import { readFileSync } from "node:fs";

import { isJsonObject, isString } from "../json/unknown.js";

export interface InrepoPackageInfo {
  name: string;
  version: string;
}

export const APP_NAME = "inrepo";
export const APP_TAGLINE = "vendor git dependencies into inrepo_modules/";

export const readOwnPackageInfo =
  function readOwnPackageInfo(): InrepoPackageInfo {
    try {
      const raw = readFileSync(
        new URL("../../package.json", import.meta.url),
        "utf-8"
      );
      const parsed: unknown = JSON.parse(raw);
      if (!isJsonObject(parsed)) {
        return { name: APP_NAME, version: "unknown" };
      }

      return {
        name:
          isString(parsed.name) && parsed.name.trim() ? parsed.name : APP_NAME,
        version:
          isString(parsed.version) && parsed.version.trim()
            ? parsed.version
            : "unknown",
      };
    } catch {
      return { name: APP_NAME, version: "unknown" };
    }
  };
