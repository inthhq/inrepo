import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { diffTrees } from '../../diff/diff-trees.js';
import { assemblePatchedTree } from '../../overlay/assemble-module.js';
import { ensurePristine } from '../../overlay/cache.js';
import { overlayDirPath, seriesDirPath } from '../../overlay/overlay-paths.js';
import { listLegacyOverlayEntries } from '../../series/legacy-overlay.js';
import { readSeriesHeaders, type SeriesPatchHeader } from '../../series/read-patch-header.js';
import { parseDiffArgs } from '../args.js';
import { selectPackages } from '../package-selection.js';
import { mergedVendorExcludes, mergedVendorKeeps } from '../vendor.js';

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Reduce a patch `Date:` header to a plain calendar date, or keep it verbatim. */
function formatPatchDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

/** One line of provenance per patch: number, subject, author, date, file count. */
function patchProvenanceLines(headers: SeriesPatchHeader[]): string[] {
  return headers.map((header) => {
    const number = String(header.index).padStart(4, '0');
    const author = header.authorEmail
      ? `${header.authorName ?? 'unknown'} <${header.authorEmail}>`
      : (header.authorName ?? 'unknown');
    const facts = [
      author,
      formatPatchDate(header.date),
      plural(header.files.length, 'file', 'files'),
    ].filter((part): part is string => part != null);
    return `  ${number}  ${header.subject || '(no subject)'}  (${facts.join(', ')})`;
  });
}

/**
 * Show the effective delta between each package's pinned upstream commit and
 * its patched tree.
 *
 * This is a viewer, not a check: it always exits 0 whether or not the trees
 * differ. Errors are reserved for packages inrepo cannot resolve.
 */
export async function cmdDiff(cwd: string, argv: string[]): Promise<void> {
  const args = parseDiffArgs(argv);
  const { packages, modules, globalExclude, globalKeep } = await selectPackages(
    cwd,
    args.name,
    'diff',
  );

  const workRoot = join(cwd, '.inrepo', 'diff');
  await mkdir(workRoot, { recursive: true });

  let first = true;
  for (const pkg of packages) {
    const module = pkg.module ?? pkg.name;
    const lockEntry = modules[module];
    if (!lockEntry) {
      throw new Error(
        `Cannot diff "${pkg.name}" without a lockfile entry. Run "inrepo add ${pkg.name}" or "inrepo sync" first.`,
      );
    }

    const pristine = await ensurePristine({
      cwd,
      name: module,
      gitUrl: lockEntry.gitUrl,
      repositoryDirectory: pkg.repositoryDirectory ?? lockEntry.repositoryDirectory,
      ref: lockEntry.ref,
      commit: lockEntry.commit,
      keep: mergedVendorKeeps(globalKeep, pkg),
      exclude: mergedVendorExcludes(globalExclude, pkg),
    });

    const headers = await readSeriesHeaders(seriesDirPath(cwd, module));
    const legacyEntries = await listLegacyOverlayEntries(overlayDirPath(cwd, module));
    const work = await mkdtemp(join(workRoot, `${module.replaceAll('/', '__')}-`));
    try {
      const patched = join(work, 'patched');
      await assemblePatchedTree({
        cwd,
        name: module,
        pristineRoot: pristine.dir,
        targetRoot: patched,
      });
      const rendered = await diffTrees({
        baseRoot: pristine.dir,
        targetRoot: patched,
        stat: args.stat,
      });

      if (!first) console.log('');
      first = false;

      const source =
        headers.length > 0
          ? `patch series (${plural(headers.length, 'patch', 'patches')})`
          : legacyEntries.length > 0
            ? 'legacy overlay'
            : 'no committed changes';
      console.log(`${module} @ ${pristine.commit.slice(0, 7)} — ${source}`);
      for (const line of patchProvenanceLines(headers)) console.log(line);
      console.log('');
      console.log(rendered === '' ? '  (no differences)' : rendered);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
