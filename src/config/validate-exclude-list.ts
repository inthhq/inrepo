import { isString } from "../json/unknown.js";
import type { JsonValue } from "../json/unknown.js";

/** Validate root or per-package `exclude` arrays from config JSON. */
export const validateExcludeList = function validateExcludeList(
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
    out.push(v.trim());
  }
  return out;
};
