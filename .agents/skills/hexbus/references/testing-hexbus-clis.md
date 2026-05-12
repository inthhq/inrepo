# Testing Hexbus CLIs

Use this when adding tests for a `hexbus` CLI or for the upstream `hexbus` package at https://github.com/inthhq/hexbus/tree/main/packages/hexbus.

## Test Strategy

- Test domain logic separately from terminal rendering.
- Use `createTestContext` for command action tests that need logger, flags, config, filesystem, telemetry, or package manager data.
- Test argument parsing with `parseCliArgs` for command selection, positional args, and global flags.
- Test expected user failures by asserting `CliError` codes.
- Keep end-to-end CLI process tests focused on startup routing, help, version, and one representative command.

## Command Action Tests

Prefer this shape:

```ts
import { createTestContext } from "hexbus";
import { describe, expect, it } from "vitest";

import { runDoctor } from "../src/commands/doctor";

describe("runDoctor", () => {
  it("reports success for a ready project", async () => {
    const context = createTestContext({
      commandName: "doctor",
      commandArgs: [],
    });

    await runDoctor(context);

    expect(context.telemetry.isDisabled()).toBe(true);
  });
});
```

## Parser Tests

Cover:

- No args.
- Known command plus positional args.
- Unknown command.
- Boolean global flags.
- String global flags with missing values.
- `--no-telemetry` style flag keys.
- Commands with subcommands if the CLI uses them.

## Error Tests

Cover:

- Missing required config.
- Invalid positional arguments.
- Refusing destructive work without confirmation.
- Conflicting flags or unsupported command combinations.
- Recovery hints for expected failures.

## Process Tests

Only add process-level tests when they protect startup behavior:

- `my-cli --version` exits before context-heavy work.
- `my-cli --help` renders command descriptions.
- `my-cli unknown` renders help or an unknown-command error.
- `my-cli command --logger debug` exposes debug output.

## Repo Commands

When working in an upstream `hexbus` checkout, run from that repo root:

- `bun run test --filter=hexbus`
- `bun run check-types --filter=hexbus`
- `bun run lint --filter=hexbus`
- `bun x ultracite fix`
