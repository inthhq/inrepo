import { performance } from "node:perf_hooks";

import { candidate, execute, oracle, scenarios } from "./check.ts";

const measured = scenarios.filter(
  (scenario) =>
    scenario.name === "help" ||
    scenario.name === "version" ||
    scenario.name === "codemods dry run"
);
const variants = [
  { entry: oracle, name: "published npm dist" },
  { entry: candidate, name: "vendored lazy source" },
] as const;

const percentile = function percentile(
  values: number[],
  fraction: number
): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
};

for (const scenario of measured) {
  for (let warmup = 0; warmup < 5; warmup += 1) {
    for (const variant of variants) {
      await execute(variant.entry, scenario.args);
    }
  }

  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  const samples = new Map(
    variants.map((variant) => [variant.name, [] as number[]])
  );
  for (let sample = 0; sample < 40; sample += 1) {
    const order = sample % 2 === 0 ? variants : [...variants].toReversed();
    for (const variant of order) {
      const start = performance.now();
      const result = await execute(variant.entry, scenario.args);
      if (result.status !== 0) {
        throw new Error(
          `${variant.name} ${scenario.name} exited ${result.status}`
        );
      }
      const bucket = samples.get(variant.name);
      if (bucket == null) {
        throw new Error(`Missing samples for ${variant.name}`);
      }
      bucket.push(performance.now() - start);
    }
  }

  console.log(
    `\n${scenario.name} — cold process, warm filesystem (40 samples)`
  );
  for (const variant of variants) {
    const values = samples.get(variant.name);
    if (values == null) {
      throw new Error(`Missing samples for ${variant.name}`);
    }
    let sum = 0;
    for (const value of values) {
      sum += value;
    }
    const mean = sum / values.length;
    console.log(
      `${variant.name.padEnd(22)} mean ${mean.toFixed(2)} ms  p50 ${percentile(values, 0.5).toFixed(2)} ms  p95 ${percentile(values, 0.95).toFixed(2)} ms`
    );
  }
}
