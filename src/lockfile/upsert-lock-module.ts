import type { LockModule } from "../types/lock-module.js";
import { readLockfile } from "./read-lockfile.js";
import { writeLockfile } from "./write-lockfile.js";

export const upsertLockModule = async function upsertLockModule(
  cwd: string,
  name: string,
  entry: LockModule
): Promise<void> {
  const { modules, graph } = await readLockfile(cwd);
  modules[name] = entry;
  await writeLockfile(cwd, modules, graph);
};
