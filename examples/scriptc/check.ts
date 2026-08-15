import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

interface Result {
  status: number;
  stderr: string;
  stdout: string;
}

const variants = [
  { command: "bun", label: "bun npm baseline", prefix: ["cli.ts"] },
  {
    command: "node",
    label: "node npm baseline",
    prefix: ["--disable-warning=ExperimentalWarning", "cli.ts"],
  },
  { command: "./demo-npm", label: "scriptc dynamic npm", prefix: [] },
  { command: "./demo-vendored", label: "scriptc static vendored", prefix: [] },
] as const;

const scenarios = [
  { args: ["greet", "scriptc", "--upper", "--repeat", "3"], label: "greet" },
  { args: ["--help"], label: "help" },
  { args: ["--version"], label: "version" },
  { args: ["unknown-command"], label: "invalid command" },
] as const;

const run = function run(command: string, args: readonly string[]): Result {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status == null) {
    throw new Error(
      `${command} terminated without an exit status (${
        result.signal ?? "unknown"
      })`
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

for (const scenario of scenarios) {
  const expected = run(variants[0].command, [
    ...variants[0].prefix,
    ...scenario.args,
  ]);
  for (const variant of variants.slice(1)) {
    const actual = run(variant.command, [...variant.prefix, ...scenario.args]);
    if (
      actual.status !== expected.status ||
      actual.stdout !== expected.stdout ||
      actual.stderr !== expected.stderr
    ) {
      throw new Error(
        `${variant.label} does not match ${variants[0].label} for ${scenario.label}\n` +
          `expected ${JSON.stringify(expected)}\n` +
          `received ${JSON.stringify(actual)}`
      );
    }
  }
}

console.log(
  `All ${scenarios.length} behaviors match across ${variants.length} variants.`
);
