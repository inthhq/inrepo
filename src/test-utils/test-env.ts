/** Environment variables that influence inrepo's CLI / setup behavior. */
export const ENV_KEYS = [
  "INREPO_CONFIG",
  "INREPO_NONINTERACTIVE",
  "INREPO_REGISTRY",
  "CI",
] as const;

export interface EnvSnapshot {
  INREPO_CONFIG?: string;
  INREPO_NONINTERACTIVE?: string;
  INREPO_REGISTRY?: string;
  CI?: string;
}

/** Snapshot the relevant `process.env` keys so a test can mutate them safely. */
export const snapshotEnv = function snapshotEnv(): EnvSnapshot {
  return {
    CI: process.env.CI,
    INREPO_CONFIG: process.env.INREPO_CONFIG,
    INREPO_NONINTERACTIVE: process.env.INREPO_NONINTERACTIVE,
    INREPO_REGISTRY: process.env.INREPO_REGISTRY,
  };
};

const clearEnvKey = function clearEnvKey(key: keyof EnvSnapshot): void {
  switch (key) {
    case "CI": {
      Reflect.deleteProperty(process.env, "CI");
      break;
    }
    case "INREPO_CONFIG": {
      Reflect.deleteProperty(process.env, "INREPO_CONFIG");
      break;
    }
    case "INREPO_NONINTERACTIVE": {
      Reflect.deleteProperty(process.env, "INREPO_NONINTERACTIVE");
      break;
    }
    case "INREPO_REGISTRY": {
      Reflect.deleteProperty(process.env, "INREPO_REGISTRY");
      break;
    }
    default: {
      break;
    }
  }
};

/** Restore each tracked key to the value it had when {@link snapshotEnv} was called. */
export const restoreEnv = function restoreEnv(snap: EnvSnapshot): void {
  if (snap.CI === undefined) {
    clearEnvKey("CI");
  } else {
    process.env.CI = snap.CI;
  }
  if (snap.INREPO_CONFIG === undefined) {
    clearEnvKey("INREPO_CONFIG");
  } else {
    process.env.INREPO_CONFIG = snap.INREPO_CONFIG;
  }
  if (snap.INREPO_NONINTERACTIVE === undefined) {
    clearEnvKey("INREPO_NONINTERACTIVE");
  } else {
    process.env.INREPO_NONINTERACTIVE = snap.INREPO_NONINTERACTIVE;
  }
  if (snap.INREPO_REGISTRY === undefined) {
    clearEnvKey("INREPO_REGISTRY");
  } else {
    process.env.INREPO_REGISTRY = snap.INREPO_REGISTRY;
  }
};
