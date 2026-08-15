import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { FIXTURE_DIR, RUNTIME_PATH_FILE } from "./runtime.ts";

const CLI = nodePath.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "src",
  "cli.ts"
);
const FILES = [
  "package.json",
  "inrepo.json",
  "inrepo.lock.json",
  "inrepo_patches/@c15t/cli/series/0001-Lazy-load-command-implementations.patch",
] as const;

const run = async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      INREPO_CONFIG: "inrepo.json",
      INREPO_NONINTERACTIVE: "1",
      INREPO_REGISTRY: "http://127.0.0.1:9",
      NO_COLOR: "1",
    },
    stderr: "inherit",
    stdout: "inherit",
  });
  const status = await proc.exited;
  if (status !== 0) {
    throw new Error(`inrepo ${args.join(" ")} failed with exit ${status}`);
  }
};

const contents = await Promise.all(
  FILES.map((file) => readFile(nodePath.join(FIXTURE_DIR, file)))
);
const key = createHash("sha256")
  .update(Buffer.concat(contents))
  .digest("hex")
  .slice(0, 16);
const runtime = nodePath.join(tmpdir(), "inrepo-c15t-full-runtime", key);
await mkdir(runtime, { recursive: true });
for (let index = 0; index < FILES.length; index += 1) {
  const target = nodePath.join(runtime, FILES[index]);
  await mkdir(nodePath.dirname(target), { recursive: true });
  await writeFile(target, contents[index]);
}

await run(runtime, ["sync"]);
await run(runtime, ["verify"]);
await writeFile(RUNTIME_PATH_FILE, `${runtime}\n`, "utf-8");
console.log(`Full c15t runtime: ${runtime}`);
