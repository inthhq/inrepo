import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { seriesDirPath } from "../overlay/overlay-paths.js";
import {
  assertPatchedSymlinksWithinRoot,
  copyTree,
  defaultSkipTreePath,
  walkTree,
} from "../overlay/tree-utils.js";
import { loadRewirePlan } from "../rewire/load-rewire-plan.js";
import { rewireTree, unrewireTree } from "../rewire/rewire-tree.js";
import type { RewirePlan } from "../rewire/rewire-tree.js";
import { applySeries } from "./apply-series.js";
import { tryFormatSeriesPatch } from "./format-series-patch.js";
import {
  nextSeriesNumber,
  readSeries,
  seriesPatchFileName,
} from "./read-series.js";
import { resolveSeriesAuthor } from "./resolve-series-author.js";
import type { SeriesAuthor } from "./series-git.js";

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
const newEmptyDirectories = async function newEmptyDirectories(
  baseRoot: string,
  moduleRoot: string
): Promise<string[]> {
  const [base, module] = await Promise.all([
    walkTree(baseRoot, {
      skip: defaultSkipTreePath,
      treatMissingAsEmpty: true,
    }),
    walkTree(moduleRoot, {
      skip: defaultSkipTreePath,
      treatMissingAsEmpty: true,
    }),
  ]);
  const paths = [...module.keys()];
  return paths
    .filter((relPosix) => module.get(relPosix)?.kind === "dir")
    .filter((relPosix) => !base.has(relPosix))
    .filter(
      (relPosix) =>
        !paths.some((candidate) => candidate.startsWith(`${relPosix}/`))
    )
    .toSorted();
};

/**
 * Capture the current edits in `moduleRoot` as a new patch appended to the
 * package's series.
 *
 * The base for the new patch is the assembled patched tree — pinned upstream
 * plus every patch already in the series — so the captured patch contains only
 * what the working tree adds on top. Each call appends exactly one patch; there
 * is no amend or squash.
 *
 * Import rewiring is a generated transform that only exists in `moduleRoot`.
 * To keep it out of the patch surface entirely, the same rewrites are computed
 * against the patched tree and undone in a scratch copy of the module tree
 * before the two are compared. The captured patch is therefore expressed in the
 * patched tree's own specifiers, and applies cleanly even when the user edited
 * the lines next to a rewired import.
 */
export const captureSeriesPatch = async function captureSeriesPatch(opts: {
  cwd: string;
  name: string;
  pristineRoot: string;
  /** The generated checkout holding the edits, i.e. `inrepo_modules/<name>`. */
  moduleRoot: string;
  /** Commit subject for the new patch; this is the recorded reason. */
  subject: string;
  author?: SeriesAuthor;
  /** Pass `null` to skip the rewiring round-trip; omit to resolve it from committed state. */
  rewire?: RewirePlan | null;
}): Promise<SeriesCaptureResult> {
  const subject = opts.subject.trim();
  if (subject === "") {
    throw new Error(
      `Refusing to capture "${opts.name}" without a patch message`
    );
  }

  const seriesDir = seriesDirPath(opts.cwd, opts.name);
  const patches = await readSeries(seriesDir);
  const number = nextSeriesNumber(patches);

  const workRoot = nodePath.join(opts.cwd, ".inrepo", "capture");
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(
    nodePath.join(workRoot, `${opts.name.replaceAll("/", "__")}-`)
  );
  const baseTree = nodePath.join(work, "base");

  try {
    await (patches.length > 0
      ? applySeries({
          pristineRoot: opts.pristineRoot,
          seriesDir,
          targetRoot: baseTree,
        })
      : copyTree(opts.pristineRoot, baseTree, {
          skip: defaultSkipTreePath,
          treatMissingAsEmpty: true,
        }));

    const plan =
      opts.rewire === undefined
        ? await loadRewirePlan(opts.cwd, opts.name)
        : opts.rewire;
    let patchedRoot = opts.moduleRoot;
    if (plan != null) {
      const { rewrites } = await rewireTree(baseTree, plan, { write: false });
      if (rewrites.size > 0) {
        patchedRoot = nodePath.join(work, "module");
        await copyTree(opts.moduleRoot, patchedRoot, {
          skip: defaultSkipTreePath,
          treatMissingAsEmpty: true,
        });
        await unrewireTree(patchedRoot, rewrites);
      }
    }

    // The generated checkout carries markers that are not part of the
    // patched tree stage and must never enter the patch surface.
    const patch = await tryFormatSeriesPatch({
      author: opts.author ?? (await resolveSeriesAuthor(opts.cwd)),
      baseRoot: baseTree,
      patchedRoot,
      skip: defaultSkipTreePath,
      startNumber: number,
      subject,
    });
    if (patch == null) {
      return { captured: false };
    }

    await assertPatchedSymlinksWithinRoot(opts.pristineRoot, opts.moduleRoot);

    const fileName = seriesPatchFileName(patch.fileName, number);
    const patchPath = nodePath.join(seriesDir, fileName);
    if (existsSync(patchPath)) {
      throw new Error(`Refusing to overwrite an existing patch: ${patchPath}`);
    }

    const droppedEmptyDirectories = await newEmptyDirectories(
      baseTree,
      opts.moduleRoot
    );

    await mkdir(seriesDir, { recursive: true });
    await writeFile(patchPath, patch.content);

    return {
      captured: true,
      droppedEmptyDirectories,
      number,
      patchFileName: fileName,
      patchPath,
    };
  } finally {
    await rm(work, { force: true, recursive: true });
  }
};
