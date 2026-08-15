import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { bench, group, run } from "mitata";

const ARGS = ["--help"];

function exec(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

for (const binary of ["./demo-npm", "./demo-static"]) {
  if (!existsSync(binary)) {
    throw new Error(`Missing ${binary}; run \`npm run build\` first.`);
  }
}

exec("./demo-npm", ARGS);
exec("./demo-static", ARGS);
exec("bun", ["cli-npm.ts", ...ARGS]);
exec("node", ["--disable-warning=ExperimentalWarning", "cli-npm.ts", ...ARGS]);

group("c15t help renderer: cold start + run (spawn per iteration)", () => {
  bench("scriptc --dynamic, npm picocolors", () => exec("./demo-npm", ARGS));
  bench("scriptc static, selected c15t source", () =>
    exec("./demo-static", ARGS)
  );
  bench("bun cli-npm.ts", () => exec("bun", ["cli-npm.ts", ...ARGS]));
  bench("node cli-npm.ts", () =>
    exec("node", ["--disable-warning=ExperimentalWarning", "cli-npm.ts", ...ARGS])
  );
});

await run();
