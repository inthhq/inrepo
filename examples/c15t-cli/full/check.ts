import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertNoNodeModulesFallback, runtimeDir } from './runtime.ts';

type Result = { status: number; stdout: string; stderr: string };

const runtime = await runtimeDir();
export const candidate = join(runtime, 'inrepo_modules', '@c15t', 'cli', 'src', 'index.ts');
export const oracle = resolve(import.meta.dir, '..', 'node_modules', '@c15t', 'cli', 'dist', 'index.mjs');
await access(candidate);
try {
  await access(oracle);
} catch {
  throw new Error(`Missing ${oracle}; run npm ci --ignore-scripts in examples/c15t-cli`);
}
await assertNoNodeModulesFallback(candidate);
const candidateSource = await readFile(candidate, 'utf8');
if (!candidateSource.includes("await import('./commands/generate')")) {
  throw new Error('The committed lazy-command patch was not applied to @c15t/cli');
}
if (candidateSource.includes("import { generate } from './commands/generate';")) {
  throw new Error('@c15t/cli still eagerly imports the setup/generate implementation');
}

const env = {
  ...process.env,
  C15T_TELEMETRY_DISABLED: '1',
  CI: '1',
  COLUMNS: '100',
  DO_NOT_TRACK: '1',
  FORCE_COLOR: '0',
  NO_COLOR: '1',
  TERM: 'dumb',
};

export const scenarios = [
  { name: 'help', args: ['--help', '--no-telemetry'] },
  { name: 'version', args: ['--version', '--no-telemetry'] },
  { name: 'invalid logger', args: ['--logger', 'nope', '--version', '--no-telemetry'] },
  { name: 'codemods dry run', args: ['codemods', '--dry-run', '--no-telemetry'] },
] as const;

export async function execute(entry: string, args: readonly string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: runtime,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

async function fixtureHash(): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(runtime, { withFileTypes: true }))
    .filter((value) => value.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name).update(await readFile(join(runtime, entry.name)));
  }
  return hash.digest('hex');
}

for (const scenario of scenarios) {
  const before = await fixtureHash();
  const [expected, actual] = await Promise.all([
    execute(oracle, scenario.args),
    execute(candidate, scenario.args),
  ]);
  if (
    actual.status !== expected.status ||
    actual.stdout !== expected.stdout ||
    actual.stderr !== expected.stderr
  ) {
    throw new Error(
      `${scenario.name} parity failed\n` +
        `oracle status=${expected.status} stdout=${expected.stdout.length} stderr=${expected.stderr.length}\n` +
        `source status=${actual.status} stdout=${actual.stdout.length} stderr=${actual.stderr.length}\n` +
        `source stderr:\n${actual.stderr}`,
    );
  }
  if ((await fixtureHash()) !== before) {
    throw new Error(`${scenario.name} mutated the controlled fixture`);
  }
  console.log(
    `✓ ${scenario.name}: exit ${actual.status}, ${actual.stdout.length} stdout bytes, ${actual.stderr.length} stderr bytes`,
  );
}

console.log('Full @c15t/cli source matches the published CLI under Bun.');
