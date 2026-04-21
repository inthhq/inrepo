export type VerifyResult =
  | { ok: true }
  | { ok: false; errors: string[] };
