// Spawn-based benchmark of the compiled binaries (plus interpreter baselines).
// Run with: bun bench.ts   (after building the binaries — see README.md)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { bench, group, run } from "mitata";

const ARGS = ["greet", "scriptc", "--upper", "--repeat", "3"];

const exec = function exec(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "ignore" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with ${result.status}`);
  }
};

for (const binary of ["./demo-npm", "./demo-vendored"]) {
  if (!existsSync(binary)) {
    throw new Error(`Missing ${binary}; run \`npm run build\` first.`);
  }
}

// Mitata reports a benchmark callback exception without failing the process.
// Preflight every timed command so a broken variant can never produce a
// successful-looking partial benchmark.
exec("./demo-npm", ARGS);
exec("./demo-vendored", ARGS);
exec("bun", ["cli.ts", ...ARGS]);
exec("node", ["--disable-warning=ExperimentalWarning", "cli.ts", ...ARGS]);

group("cold start + run (spawn per iteration)", () => {
  bench("scriptc --dynamic, deps from npm", () => exec("./demo-npm", ARGS));
  bench("scriptc static, deps vendored via inrepo", () =>
    exec("./demo-vendored", ARGS));
  bench("bun cli.ts (interpreter baseline)", () =>
    exec("bun", ["cli.ts", ...ARGS]));
  bench("node cli.ts (interpreter baseline)", () =>
    exec("node", ["--disable-warning=ExperimentalWarning", "cli.ts", ...ARGS]));
});

await run();
