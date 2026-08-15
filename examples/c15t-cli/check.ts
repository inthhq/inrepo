import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

interface Result {
  status: number;
  stderr: string;
  stdout: string;
}

const variants = [
  { command: "bun", label: "bun npm reference", prefix: ["cli-npm.ts"] },
  {
    command: "node",
    label: "node npm reference",
    prefix: ["--disable-warning=ExperimentalWarning", "cli-npm.ts"],
  },
  { command: "./demo-npm", label: "scriptc dynamic npm", prefix: [] },
  {
    command: "./demo-static",
    label: "scriptc static selected source",
    prefix: [],
  },
] as const;

const run = function run(command: string, args: readonly string[]): Result {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status == null) {
    throw new Error(
      `${command} terminated without an exit status (${result.signal ?? "unknown"})`
    );
  }
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

for (const variant of variants) {
  if (variant.command.startsWith("./") && !existsSync(variant.command)) {
    throw new Error(`Missing ${variant.command}; run \`npm run build\` first.`);
  }
}

for (const args of [[], ["--help"]] as const) {
  const expected = run(variants[0].command, [...variants[0].prefix, ...args]);
  for (const variant of variants.slice(1)) {
    const actual = run(variant.command, [...variant.prefix, ...args]);
    if (
      actual.status !== expected.status ||
      actual.stdout !== expected.stdout ||
      actual.stderr !== expected.stderr
    ) {
      throw new Error(
        `${variant.label} does not match ${variants[0].label} for ${JSON.stringify(args)}\n` +
          `expected ${JSON.stringify(expected)}\n` +
          `received ${JSON.stringify(actual)}`
      );
    }
  }
}

console.log(
  "Help output and exit behavior match for 2 scenarios across 4 variants."
);
