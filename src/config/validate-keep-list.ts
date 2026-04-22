import { isAbsolute } from 'node:path';

/** Validate root or per-package `keep` allowlist entries (literals only, no slash-regex form). */
export function validateKeepList(raw: unknown, label: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of strings when set`);
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'string' || !v.trim()) {
      throw new Error(`${label}[${i}] must be a non-empty string`);
    }
    const t = v.trim().replace(/\\/g, '/');
    if (t.startsWith('/')) {
      throw new Error(
        `${label}[${i}] must be a relative path (no leading "/"); use the object "exclude" field for slash-regex patterns`,
      );
    }
    if (isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(v.trim())) {
      throw new Error(`${label}[${i}] must be relative to the module root`);
    }
    for (const seg of t.split('/')) {
      if (seg === '..') {
        throw new Error(`${label}[${i}] must not contain ".."`);
      }
    }
    out.push(t.replace(/\/+$/, ''));
  }
  return out;
}
