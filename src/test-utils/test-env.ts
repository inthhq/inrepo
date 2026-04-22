/** Environment variables that influence inrepo's CLI / setup behavior. */
export const ENV_KEYS = ['INREPO_CONFIG', 'INREPO_NONINTERACTIVE', 'CI'] as const;

export type EnvSnapshot = Record<string, string | undefined>;

/** Snapshot the relevant `process.env` keys so a test can mutate them safely. */
export function snapshotEnv(): EnvSnapshot {
  const out: EnvSnapshot = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}

/** Restore each tracked key to the value it had when {@link snapshotEnv} was called. */
export function restoreEnv(snap: EnvSnapshot): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
