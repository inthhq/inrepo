import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

/** Remove destination if present (caller should log a warning before invoking). */
export async function removeDestIfExists(dest: string): Promise<void> {
  if (existsSync(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
}
