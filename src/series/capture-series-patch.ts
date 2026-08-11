import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seriesDirPath } from '../overlay/overlay-paths.js';
import { copyTree, defaultSkipTreePath, walkTree } from '../overlay/tree-utils.js';
import { applySeries } from './apply-series.js';
import { tryFormatSeriesPatch } from './format-series-patch.js';
import { isSeriesPatchFileName, nextSeriesNumber, readSeries } from './read-series.js';
import { resolveSeriesAuthor } from './resolve-series-author.js';
import type { SeriesAuthor } from './series-git.js';

export type SeriesCaptureResult =
  | { captured: false }
  | {
      captured: true;
      /** Absolute path of the patch that was appended to the series. */
      patchPath: string;
      patchFileName: string;
      /** Numeric prefix given to the new patch. */
      number: number;
      /**
       * Directories the working tree added but left empty. Git cannot record
       * them, so they will not come back on the next sync.
       */
      droppedEmptyDirectories: string[];
    };

/** Directories present and empty in `moduleRoot` that the base tree does not have. */
async function newEmptyDirectories(baseRoot: string, moduleRoot: string): Promise<string[]> {
  const [base, module] = await Promise.all([
    walkTree(baseRoot, { skip: defaultSkipTreePath, treatMissingAsEmpty: true }),
    walkTree(moduleRoot, { skip: defaultSkipTreePath, treatMissingAsEmpty: true }),
  ]);
  const paths = [...module.keys()];
  return paths
    .filter((relPosix) => module.get(relPosix)?.kind === 'dir')
    .filter((relPosix) => !base.has(relPosix))
    .filter((relPosix) => !paths.some((candidate) => candidate.startsWith(`${relPosix}/`)))
    .sort();
}

/**
 * `git format-patch` derives the file name from the subject, which can collapse
 * to nothing for a subject made entirely of punctuation. The series reader
 * requires `NNNN-<slug>.patch`, so fall back to a generic slug.
 */
function seriesPatchFileName(produced: string, number: number): string {
  if (isSeriesPatchFileName(produced)) return produced;
  return `${String(number).padStart(4, '0')}-patch.patch`;
}

/**
 * Capture the current edits in `moduleRoot` as a new patch appended to the
 * package's series.
 *
 * The base for the new patch is the assembled patched tree — pinned upstream
 * plus every patch already in the series — so the captured patch contains only
 * what the working tree adds on top. Each call appends exactly one patch; there
 * is no amend or squash.
 */
export async function captureSeriesPatch(opts: {
  cwd: string;
  name: string;
  pristineRoot: string;
  /** The generated checkout holding the edits, i.e. `inrepo_modules/<name>`. */
  moduleRoot: string;
  /** Commit subject for the new patch; this is the recorded reason. */
  subject: string;
  author?: SeriesAuthor;
}): Promise<SeriesCaptureResult> {
  const subject = opts.subject.trim();
  if (subject === '') {
    throw new Error(`Refusing to capture "${opts.name}" without a patch message`);
  }

  const seriesDir = seriesDirPath(opts.cwd, opts.name);
  const patches = await readSeries(seriesDir);
  const number = nextSeriesNumber(patches);

  const workRoot = join(opts.cwd, '.inrepo', 'capture');
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(join(workRoot, `${opts.name.replaceAll('/', '__')}-`));
  const baseTree = join(work, 'base');

  try {
    if (patches.length > 0) {
      await applySeries({
        pristineRoot: opts.pristineRoot,
        seriesDir,
        targetRoot: baseTree,
      });
    } else {
      await copyTree(opts.pristineRoot, baseTree, {
        skip: defaultSkipTreePath,
        treatMissingAsEmpty: true,
      });
    }

    const patch = await tryFormatSeriesPatch({
      baseRoot: baseTree,
      patchedRoot: opts.moduleRoot,
      subject,
      author: opts.author ?? (await resolveSeriesAuthor(opts.cwd)),
      startNumber: number,
      // The generated checkout carries markers that are not part of the
      // patched tree stage and must never enter the patch surface.
      skip: defaultSkipTreePath,
    });
    if (patch == null) return { captured: false };

    const fileName = seriesPatchFileName(patch.fileName, number);
    const patchPath = join(seriesDir, fileName);
    if (existsSync(patchPath)) {
      throw new Error(`Refusing to overwrite an existing patch: ${patchPath}`);
    }

    const droppedEmptyDirectories = await newEmptyDirectories(baseTree, opts.moduleRoot);

    await mkdir(seriesDir, { recursive: true });
    await writeFile(patchPath, patch.content);

    return {
      captured: true,
      patchPath,
      patchFileName: fileName,
      number,
      droppedEmptyDirectories,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
