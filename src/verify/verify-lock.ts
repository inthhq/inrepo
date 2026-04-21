import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readLockfile } from '../lockfile/read-lockfile.js';
import { moduleDestPath } from '../paths/module-dest-path.js';
import { runGitCapture } from '../git/run-git-capture.js';
import { normalizeGithubHttpsUrl } from '../registry/normalize-github-https-url.js';
import type { VerifyResult } from '../types/verify-result.js';

const VENDOR_MARKER = '.inrepo-vendor.json';

function remotesEquivalent(a: string, b: string): boolean {
  const na = normalizeGithubHttpsUrl(a) ?? a.replace(/\.git$/i, '').toLowerCase();
  const nb = normalizeGithubHttpsUrl(b) ?? b.replace(/\.git$/i, '').toLowerCase();
  return na === nb;
}

function parseVendorMarker(raw: string): { commit: string; gitUrl: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (data == null || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  const commit = rec.commit;
  const gitUrl = rec.gitUrl;
  if (typeof commit !== 'string' || typeof gitUrl !== 'string') return null;
  return { commit: commit.toLowerCase(), gitUrl };
}

export async function verifyLock(cwd: string): Promise<VerifyResult> {
  const { modules } = await readLockfile(cwd);
  const names = Object.keys(modules);
  if (names.length === 0) {
    return { ok: false, errors: ['No modules in inrepo.lock.json (nothing to verify).'] };
  }

  const errors: string[] = [];

  for (const name of names) {
    const entry = modules[name];
    const dest = moduleDestPath(cwd, name);
    if (!existsSync(dest)) {
      errors.push(`Missing directory for "${name}": ${dest}`);
      continue;
    }
    const st = await stat(dest);
    if (!st.isDirectory()) {
      errors.push(`Path for "${name}" is not a directory: ${dest}`);
      continue;
    }
    const gitDir = join(dest, '.git');
    const markerPath = join(dest, VENDOR_MARKER);

    if (existsSync(gitDir)) {
      try {
        const head = await runGitCapture(['rev-parse', 'HEAD'], { cwd: dest });
        const headNorm = head.toLowerCase();
        if (headNorm !== entry.commit.toLowerCase()) {
          errors.push(
            `"${name}": HEAD ${headNorm} does not match lock commit ${entry.commit.toLowerCase()}`,
          );
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(`"${name}": ${err.message}`);
      }

      try {
        const origin = await runGitCapture(['remote', 'get-url', 'origin'], { cwd: dest });
        if (!remotesEquivalent(origin, entry.gitUrl)) {
          errors.push(
            `"${name}": origin URL does not match lock (origin=${origin}, lock=${entry.gitUrl})`,
          );
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(`"${name}" remote check: ${err.message}`);
      }
    } else if (existsSync(markerPath)) {
      let marker: { commit: string; gitUrl: string } | null;
      try {
        marker = parseVendorMarker(await readFile(markerPath, 'utf8'));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        errors.push(`"${name}": could not read ${VENDOR_MARKER}: ${err.message}`);
        continue;
      }
      if (!marker) {
        errors.push(`"${name}": invalid or empty ${VENDOR_MARKER}`);
        continue;
      }
      if (marker.commit !== entry.commit.toLowerCase()) {
        errors.push(
          `"${name}": vendor marker commit ${marker.commit} does not match lock ${entry.commit.toLowerCase()}`,
        );
      }
      if (!remotesEquivalent(marker.gitUrl, entry.gitUrl)) {
        errors.push(
          `"${name}": vendor marker gitUrl does not match lock (marker=${marker.gitUrl}, lock=${entry.gitUrl})`,
        );
      }
    } else {
      errors.push(
        `"${name}" has no .git and no ${VENDOR_MARKER} (re-run inrepo sync): ${dest}`,
      );
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
}
