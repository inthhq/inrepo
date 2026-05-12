import {
  ensureInrepoInitialized,
  isInrepoInitialized,
} from '../../config/ensure-inrepo-initialized.js';
import { printBanner } from '../rendering.js';
import { ui } from '../ui.js';

export async function cmdInit(cwd: string): Promise<void> {
  printBanner();
  if (isInrepoInitialized(cwd)) {
    ui.info('inrepo is already initialized in this project.');
    return;
  }

  await ensureInrepoInitialized(cwd);
  // ensureInrepoInitialized already prints intro/outro on success.
  ui.message(
    'Next: run `inrepo add <name>` to pin a package, or edit the config and run `inrepo sync`; later use `inrepo patch <name>` to capture shared changes.',
  );
}
