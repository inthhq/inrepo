import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = "@c15t/cli";
const VERSION = "2.2.0";
const CLI_PATH = resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const OFFLINE_REGISTRY = "http://127.0.0.1:9";

type Lock = {
  lockfileVersion: number;
  modules: Record<string, { source: string }>;
  graph: Record<
    string,
    { dependencies?: Record<string, { module: string; range: string; version?: string }> }
  >;
};

async function run(cwd: string, args: string[], registry?: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      INREPO_CONFIG: "inrepo.json",
      INREPO_NONINTERACTIVE: "1",
      NO_COLOR: "1",
      ...(registry == null ? {} : { INREPO_REGISTRY: registry }),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`inrepo ${args.join(" ")} failed with exit ${exitCode}\n${stdout}${stderr}`);
  }
}

function edge(lock: Lock, parent: string, dependency: string): string {
  const module = lock.graph[parent]?.dependencies?.[dependency]?.module;
  if (module == null) throw new Error(`Missing ${parent} -> ${dependency} graph edge`);
  return module;
}

function assertIncompatibleInstances(lock: Lock): void {
  const cittyFromGiget = edge(lock, "giget@2.0.0", "citty");
  const cittyFromNypm = edge(lock, "nypm@0.6.9", "citty");
  if (cittyFromGiget === cittyFromNypm) {
    throw new Error(`Expected separate citty instances, both edges target ${cittyFromGiget}`);
  }

  for (const source of ["citty", "content-type", "hono"]) {
    const instances = Object.entries(lock.modules).filter(([, entry]) => entry.source === source);
    if (instances.length < 2) {
      throw new Error(`Expected multiple ${source} instances, received ${instances.length}`);
    }
  }
}

const cwd = await mkdtemp(join(tmpdir(), "inrepo-c15t-with-deps-"));
try {
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "c15t-with-deps-probe", private: true }, null, 2)}\n`,
    "utf8",
  );

  await run(cwd, ["add", PACKAGE, "--ref", `${PACKAGE}@${VERSION}`, "--with-deps"]);
  const lock = JSON.parse(await readFile(join(cwd, "inrepo.lock.json"), "utf8")) as Lock;
  if (lock.lockfileVersion !== 4) {
    throw new Error(`Expected lockfileVersion 4, received ${lock.lockfileVersion}`);
  }
  if (Object.keys(lock.modules).length < 180 || lock.modules[PACKAGE]?.source !== PACKAGE) {
    throw new Error(`Unexpected ${PACKAGE} closure: ${Object.keys(lock.modules).length} modules`);
  }
  assertIncompatibleInstances(lock);

  // Rebuild entirely from committed config/lock plus the immutable repository
  // cache. A dead registry proves sync and verify do not re-resolve npm ranges.
  await rm(join(cwd, "inrepo_modules"), { recursive: true, force: true });
  await run(cwd, ["sync"], OFFLINE_REGISTRY);
  await run(cwd, ["verify"], OFFLINE_REGISTRY);

  console.log(
    `${PACKAGE}@${VERSION}: resolved, materialized, synced, and verified ` +
      `${Object.keys(lock.modules).length} exact runtime module instances.`,
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
