// Spawn-based benchmark of the compiled binaries (plus interpreter baselines).
// Run with: bun bench.ts   (after building the binaries — see README.md)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { bench, group, run } from "mitata";

const ARGS = ["greet", "scriptc", "--upper", "--repeat", "3"];

function exec(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with ${result.status}`);
  }
}

group("cold start + run (spawn per iteration)", () => {
  if (existsSync("./demo-npm")) {
    bench("scriptc --dynamic, deps from npm", () => exec("./demo-npm", ARGS));
  }
  if (existsSync("./demo-vendored")) {
    bench("scriptc static, deps vendored via inrepo", () =>
      exec("./demo-vendored", ARGS),
    );
  }
  if (existsSync("./demo-vendored-dynamic")) {
    bench("scriptc --dynamic, deps vendored via inrepo", () =>
      exec("./demo-vendored-dynamic", ARGS),
    );
  }
  bench("bun cli.ts (interpreter baseline)", () =>
    exec("bun", ["cli.ts", ...ARGS]),
  );
  bench("node cli.ts (interpreter baseline)", () =>
    exec("node", ["--disable-warning=ExperimentalWarning", "cli.ts", ...ARGS]),
  );
});

await run();
