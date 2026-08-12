import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_NAME = "@c15t/cli";
const VERSION = "2.2.0";
const COMMIT = "017433b2ca27e29177c320f51b973e4a78b6851e";
const SOURCE_SHA256 =
  "c2c631683cb50913e8afa2102dd030d1dfa5aee67559904a7ddac98e26d6c1e1";
const CLI_PATH = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

type RegistryVersion = {
  dependencies?: Record<string, string>;
  gitHead?: string;
  name?: string;
  repository?: { directory?: string; type?: string; url?: string } | string;
  version?: string;
};

async function loadPublishedMetadata(): Promise<RegistryVersion> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${VERSION}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${url}`);
  }
  return (await response.json()) as RegistryVersion;
}

function assertPublishedMetadata(metadata: RegistryVersion): void {
  if (metadata.name !== PACKAGE_NAME || metadata.version !== VERSION) {
    throw new Error(
      `Expected ${PACKAGE_NAME}@${VERSION}, received ${metadata.name ?? "?"}@${metadata.version ?? "?"}`
    );
  }
  if (metadata.gitHead !== COMMIT) {
    throw new Error(`Expected gitHead ${COMMIT}, received ${metadata.gitHead ?? "?"}`);
  }
  const repository = metadata.repository;
  if (
    repository == null ||
    typeof repository === "string" ||
    repository.url !== "git+https://github.com/c15t/c15t.git" ||
    repository.directory !== "packages/cli"
  ) {
    throw new Error(`Unexpected repository metadata: ${JSON.stringify(repository)}`);
  }
  if (Object.keys(metadata.dependencies ?? {}).length !== 16) {
    throw new Error("Expected 16 direct runtime dependencies");
  }
}

async function run(cwd: string, args: string[], label: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, INREPO_NONINTERACTIVE: "1", NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit ${exitCode}\n${stdout}${stderr}`);
  }
}

async function verifyMaterializedSource(cwd: string): Promise<void> {
  const moduleRoot = join(cwd, "inrepo_modules", "@c15t", "cli");
  const source = await readFile(join(moduleRoot, "src", "actions", "show-help-menu.ts"));
  const actual = createHash("sha256").update(source).digest("hex");
  if (actual !== SOURCE_SHA256) {
    throw new Error(`Selected help source hash changed: expected ${SOURCE_SHA256}, received ${actual}`);
  }
  const manifest = JSON.parse(await readFile(join(moduleRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (manifest.name !== PACKAGE_NAME || manifest.version !== VERSION) {
    throw new Error(
      `Materialized the wrong package: ${manifest.name ?? "?"}@${manifest.version ?? "?"}`
    );
  }
}

assertPublishedMetadata(await loadPublishedMetadata());

const cwd = await mkdtemp(join(tmpdir(), "inrepo-c15t-cli-case-"));
try {
  await cp(join(import.meta.dir, "vendor", "inrepo.json"), join(cwd, "inrepo.json"));
  await cp(
    join(import.meta.dir, "vendor", "inrepo.lock.json"),
    join(cwd, "inrepo.lock.json"),
  );
  await writeFile(
    join(cwd, "package.json"),
    `${JSON.stringify({ name: "c15t-help-source-probe", private: true }, null, 2)}\n`,
    "utf8"
  );

  await run(cwd, ["sync"], "inrepo sync");
  await run(cwd, ["verify"], "inrepo verify");
  await verifyMaterializedSource(cwd);
  console.log(
    `${PACKAGE_NAME}@${VERSION}: inrepo selected packages/cli at ${COMMIT.slice(0, 7)} and verified the exact help source.`
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
