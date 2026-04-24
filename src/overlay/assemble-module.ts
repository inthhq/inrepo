import { finalizeVendorCheckout } from '../git/finalize-vendor-checkout.js';
import { applyOverlay } from './apply-overlay.js';
import { readDeletionsFile } from './deletions-file.js';
import { overlayDeletionsPath, overlayDirPath } from './overlay-paths.js';

export async function assembleModuleTree(opts: {
  cwd: string;
  name: string;
  pristineRoot: string;
  commit: string;
  gitUrl: string;
  targetRoot: string;
}): Promise<string> {
  const overlayRoot = overlayDirPath(opts.cwd, opts.name);
  const deletions = await readDeletionsFile(overlayDeletionsPath(opts.cwd, opts.name));
  await applyOverlay({
    pristineRoot: opts.pristineRoot,
    overlayRoot,
    deletions,
    targetRoot: opts.targetRoot,
  });
  await finalizeVendorCheckout(opts.targetRoot, {
    commit: opts.commit,
    gitUrl: opts.gitUrl,
  });
  return opts.targetRoot;
}
