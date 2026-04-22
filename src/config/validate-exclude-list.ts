/** Validate root or per-package `exclude` arrays from config JSON. */
export function validateExcludeList(raw: unknown, label: string): string[] {
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
    out.push(v.trim());
  }
  return out;
}
