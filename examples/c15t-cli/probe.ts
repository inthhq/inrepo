import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_NAME = "@c15t/cli";
const VERSION = "2.2.0";
const REF = `${PACKAGE_NAME}@${VERSION}`;
const COMMIT = "017433b2ca27e29177c320f51b973e4a78b6851e";
const EXPECTED_DIAGNOSTIC =
  'the repository root declares package "c15t-workspace". Monorepo package subdirectories are not supported yet.';
const CLI_PATH = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

type RegistryVersion = {
  dependencies?: Record<string, string>;
  gitHead?: string;
  name?: string;
  repository?: { directory?: string; type?: string; url?: string } | string;
  version?: string;
};

async function loadPublishedMetadata(): Promise<RegistryVersion> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(
    PACKAGE_NAME
  )}/${VERSION}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`npm registry returned ${response.status} for ${url}`);
  return (await response.json()) as RegistryVersion;
}

function assertPublishedMetadata(metadata: RegistryVersion): void {
  if (metadata.name !== PACKAGE_NAME || metadata.version !== VERSION) {
    throw new Error(
      `Expected ${PACKAGE_NAME}@${VERSION}, received ${metadata.name ?? "?"}@${
        metadata.version ?? "?"
      }`
    );
  }
  if (metadata.gitHead !== COMMIT) {
    throw new Error(
      `Expected gitHead ${COMMIT}, received ${metadata.gitHead ?? "?"}`
    );
  }
  const repository = metadata.repository;
  if (
    repository == null ||
    typeof repository === "string" ||
    repository.url !== "git+https://github.com/c15t/c15t.git" ||
    repository.directory !== "packages/cli"
  ) {
    throw new Error(
      `Unexpected repository metadata: ${JSON.stringify(repository)}`
    );
  }
  const directDependencies = Object.keys(metadata.dependencies ?? {});
  if (directDependencies.length !== 16) {
    throw new Error(
      `Expected 16 direct runtime dependencies, received ${directDependencies.length}`
    );
  }
}

async function runProbe(cwd: string): Promise<void> {
  const configPath = join(cwd, "inrepo.json");
  const packagePath = join(cwd, "package.json");
  const config = `${JSON.stringify({ packages: [] }, null, 2)}\n`;
  const hostPackage = `${JSON.stringify(
    { name: "c15t-cli-inrepo-probe", private: true },
    null,
    2
  )}\n`;
  await Bun.write(configPath, config);
  await Bun.write(packagePath, hostPackage);

  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_PATH,
      "add",
      PACKAGE_NAME,
      "--ref",
      REF,
      "--with-deps",
    ],
    {
      cwd,
      env: { ...process.env, INREPO_NONINTERACTIVE: "1", NO_COLOR: "1" },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 1 || !stderr.includes(EXPECTED_DIAGNOSTIC)) {
    throw new Error(
      `Expected the monorepo diagnostic, received exit ${exitCode}\n${stdout}${stderr}`
    );
  }
  if (existsSync(join(cwd, "inrepo.lock.json"))) {
    throw new Error("The failed dependency plan wrote inrepo.lock.json");
  }
  if ((await readFile(configPath, "utf8")) !== config) {
    throw new Error("The failed dependency plan changed inrepo.json");
  }
  if ((await readFile(packagePath, "utf8")) !== hostPackage) {
    throw new Error("The failed dependency plan changed package.json");
  }
}

const metadata = await loadPublishedMetadata();
assertPublishedMetadata(metadata);

const cwd = await mkdtemp(join(tmpdir(), "inrepo-c15t-cli-case-"));
try {
  await runProbe(cwd);
  console.log(
    `${PACKAGE_NAME}@${VERSION}: scoped resolution reaches the explicit packages/cli monorepo boundary without project writes.`
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
