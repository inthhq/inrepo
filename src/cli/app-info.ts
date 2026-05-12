import { readFileSync } from 'node:fs';

export type InrepoPackageInfo = {
  name: string;
  version: string;
};

export const APP_NAME = 'inrepo';
export const APP_TAGLINE = 'vendor git dependencies into inrepo_modules/';

export function readOwnPackageInfo(): InrepoPackageInfo {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { name: APP_NAME, version: 'unknown' };
    }

    const pkg = parsed as Record<string, unknown>;
    return {
      name: typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : APP_NAME,
      version: typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : 'unknown',
    };
  } catch {
    return { name: APP_NAME, version: 'unknown' };
  }
}
