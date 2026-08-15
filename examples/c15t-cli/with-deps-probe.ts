import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

const PACKAGE = "@c15t/cli";
const VERSION = "2.2.0";
const CLI_PATH = nodePath.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
const OFFLINE_REGISTRY = "http://127.0.0.1:9";

interface Lock {
  lockfileVersion: number;
  modules: Record<
    string,
    { source: string; artifact?: { tarballUrl: string; integrity: string } }
  >;
  graph: Record<
    string,
    {
      dependencies?: Record<
        string,
        { module: string; range: string; version?: string }
      >;
    }
  >;
}

const run = async function run(
  cwd: string,
  args: string[],
  registry?: string
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    INREPO_CONFIG: "inrepo.json",
    INREPO_NONINTERACTIVE: "1",
    NO_COLOR: "1",
  };
  if (registry != null) {
    env.INREPO_REGISTRY = registry;
  }
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `inrepo ${args.join(" ")} failed with exit ${exitCode}\n${stdout}${stderr}`
    );
  }
};

const edge = function edge(
  lock: Lock,
  parent: string,
  dependency: string
): string {
  const module = lock.graph[parent]?.dependencies?.[dependency]?.module;
  if (module == null) {
    throw new Error(`Missing ${parent} -> ${dependency} graph edge`);
  }
  return module;
};

const assertIncompatibleInstances = function assertIncompatibleInstances(
  lock: Lock
): void {
  const cittyFromGiget = edge(lock, "giget@2.0.0", "citty");
  const cittyFromNypm = edge(lock, "nypm@0.6.9", "citty");
  if (cittyFromGiget === cittyFromNypm) {
    throw new Error(
      `Expected separate citty instances, both edges target ${cittyFromGiget}`
    );
  }

  for (const source of ["citty", "content-type", "hono"]) {
    const instances = Object.entries(lock.modules).filter(
      ([, entry]) => entry.source === source
    );
    if (instances.length < 2) {
      throw new Error(
        `Expected multiple ${source} instances, received ${instances.length}`
      );
    }
  }
};

const cwd = await mkdtemp(nodePath.join(tmpdir(), "inrepo-c15t-with-deps-"));
try {
  await writeFile(
    nodePath.join(cwd, "package.json"),
    `${JSON.stringify({ name: "c15t-with-deps-probe", private: true }, null, 2)}\n`,
    "utf-8"
  );

  await run(cwd, [
    "add",
    PACKAGE,
    "--ref",
    `${PACKAGE}@${VERSION}`,
    "--with-deps",
  ]);
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  const lock = JSON.parse(
    await readFile(nodePath.join(cwd, "inrepo.lock.json"), "utf-8")
  ) as Lock;
  if (lock.lockfileVersion !== 5) {
    throw new Error(
      `Expected lockfileVersion 5, received ${lock.lockfileVersion}`
    );
  }
  if (
    Object.keys(lock.modules).length < 180 ||
    lock.modules[PACKAGE]?.source !== PACKAGE
  ) {
    throw new Error(
      `Unexpected ${PACKAGE} closure: ${Object.keys(lock.modules).length} modules`
    );
  }
  assertIncompatibleInstances(lock);
  const artifactModules = Object.values(lock.modules).filter(
    (entry) => entry.artifact != null
  );
  if (artifactModules.length < Object.keys(lock.modules).length - 1) {
    throw new Error(
      `Expected every registry dependency to retain its published artifact; received ${artifactModules.length}`
    );
  }

  // Rebuild entirely from committed config/lock plus the immutable repository
  // cache. A dead registry proves sync and verify do not re-resolve npm ranges.
  await rm(nodePath.join(cwd, "inrepo_modules"), {
    force: true,
    recursive: true,
  });
  await run(cwd, ["sync"], OFFLINE_REGISTRY);
  await run(cwd, ["verify"], OFFLINE_REGISTRY);

  console.log(
    `${PACKAGE}@${VERSION}: resolved, materialized, synced, and verified ` +
      `${Object.keys(lock.modules).length} exact runtime module instances.`
  );
} finally {
  await rm(cwd, { force: true, recursive: true });
}
