import { globalFlags, showHelpMenu, type CliCommand, type CliContext } from 'hexbus';
import { APP_NAME, APP_TAGLINE, type InrepoPackageInfo } from './app-info.js';

// ASCII banner artwork; lines are joined explicitly to preserve formatting.
const BANNER_LINES = [
  '░██',
  '',
  '░██░████████  ░██░████  ░███████  ░████████   ░███████',
  '░██░██    ░██ ░███     ░██    ░██ ░██    ░██ ░██    ░██',
  '░██░██    ░██ ░██      ░█████████ ░██    ░██ ░██    ░██',
  '░██░██    ░██ ░██      ░██        ░███   ░██ ░██    ░██',
  '░██░██    ░██ ░██       ░███████  ░██░█████   ░███████',
  '                                  ░██',
  '                                  ░██',
  '',
];

let bannerShown = false;

export function printBanner(): void {
  if (bannerShown) return;
  bannerShown = true;
  console.log(BANNER_LINES.join('\n'));
}

export function showInrepoHelp(
  context: Pick<CliContext, 'logger'>,
  packageInfo: InrepoPackageInfo,
  commands: CliCommand[],
): void {
  showHelpMenu(
    context,
    {
      appName: APP_NAME,
      docsUrl: 'https://github.com/inthhq/inrepo#readme',
      version: packageInfo.version,
    },
    commands,
    globalFlags,
  );
  context.logger.message(`${APP_NAME} — ${APP_TAGLINE}`);
  context.logger.note(
    [
      'Usage:',
      '  inrepo                                       (first-time init, then prints help)',
      '  inrepo init',
      '  inrepo sync [--force]',
      '  inrepo patch [<name>] [-m "reason"]',
      '  inrepo diff [<name>] [--stat]',
      '  inrepo update <name> [--ref <ref>] [--continue] [--abort]',
      '  inrepo migrate <name>',
      '  inrepo verify',
      '  inrepo add [-D|--dev] <name> [--git <url>] [--repository-directory <path>] [--ref <ref>] [--with-deps] [--no-save]',
      '',
      'Options (add):',
      '  -D, --dev     Wire package.json#devDependencies instead of #dependencies',
      '  --git <url>   Git clone URL (optional if npm registry has a GitHub repository field)',
      '  --repository-directory <path>   Package root within the git repository',
      '  --ref <ref>   Branch, tag, or commit SHA to pin',
      '  --with-deps   Also vendor the runtime dependency closure and record it in the lockfile',
      '  --no-save     Do not upsert config and skip first-time setup',
      '',
      'Options (sync):',
      '  --force       Discard uncaptured edits in inrepo_modules after saving a backup under .inrepo/backups/',
      '',
      'Options (patch):',
      '  -m <reason>   Message recorded as the patch subject (required for patch-series capture)',
      '',
      'Options (diff):',
      '  --stat        Show a per-file +/- summary instead of the full unified diff',
      '',
      'Options (update):',
      '  --ref <ref>   New branch, tag, or commit to pin (saved to config on success)',
      '  --continue    Finish an update after resolving conflicts in .inrepo/updates/<name>/repo',
      '  --abort       Discard an in-progress update and leave the project unchanged',
      '',
      'Workflow:',
      '  inrepo add|sync -> edit files in inrepo_modules/<name>/ -> inrepo patch <name> -m "reason" -> git commit -> teammates pull -> inrepo sync',
    ].join('\n'),
    'inrepo details',
  );
}
