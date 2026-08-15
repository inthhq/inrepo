import nodePath from "node:path";

import { isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";

/** Validate root or per-package `keep` allowlist entries (literals only, no slash-regex form). */
export const validateKeepList = function validateKeepList(
  raw: JsonValue | undefined,
  label: string
): string[] {
  if (raw == null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TypeError(`${label} must be an array of strings when set`);
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i];
    if (!isString(v) || !v.trim()) {
      throw new Error(`${label}[${i}] must be a non-empty string`);
    }
    const t = v.trim().replaceAll("\\", "/");
    if (t.startsWith("/")) {
      throw new Error(
        `${label}[${i}] must be a relative path (no leading "/"); use the object "exclude" field for slash-regex patterns`
      );
    }
    if (nodePath.isAbsolute(t) || /^[A-Za-z]:[\\/]/u.test(v.trim())) {
      throw new Error(`${label}[${i}] must be relative to the module root`);
    }
    for (const seg of t.split("/")) {
      if (seg === "..") {
        throw new Error(`${label}[${i}] must not contain ".."`);
      }
    }
    out.push(t.replace(/\/+$/u, ""));
  }
  return out;
};
