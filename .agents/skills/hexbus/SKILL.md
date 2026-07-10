---
name: hexbus
description: Use when creating, improving, or reviewing high-quality CLIs with hexbus, including command design, argument parsing, CliContext services, help/version output, telemetry, errors, spinners, testing, and package manager/framework detection.
---

# Hexbus

Use this skill to create good CLIs with `hexbus`, the opinionated TypeScript ESM CLI framework from https://github.com/inthhq/hexbus.

## Start Here

- Do not assume the upstream `hexbus` monorepo exists in the user's workspace.
- For public API intent, use the package docs if installed, or read https://github.com/inthhq/hexbus/blob/main/packages/hexbus/README.md.
- Use https://github.com/inthhq/hexbus/blob/main/examples/minimal-cli/src/index.ts as the canonical runnable consumer pattern.
- Check https://github.com/inthhq/hexbus/blob/main/packages/hexbus/src/index.ts for current exports instead of assuming an API exists.
- When editing this skill repo itself, a vendored snapshot may exist at `inrepo_modules/hexbus`; treat GitHub as the portable source for agents that only receive the skill.
- Keep `hexbus` and `@inth/hexbus-*` packages free of product-specific imports and copy.

## Consumer Pattern

Build CLIs around a small command table and one resolved context:

```ts
import {
  createCliContext,
  displayIntro,
  globalFlags,
  isVersionRequest,
  printVersionInfo,
  showHelpMenu,
  startBackgroundUpdateCheck,
} from "hexbus";
import type { CliCommand } from "hexbus";
```

1. Define `CliCommand[]` with stable `name`, `label`, `hint`, `description`, and an async `action(context)`.
2. Handle `-v` / `--version` early with `isVersionRequest` and `printVersionInfo`.
3. Call `createCliContext({ rawArgs, commands, appName, configName })` once.
4. Start update checks with `startBackgroundUpdateCheck` during normal command execution.
5. Render `--help` with `showHelpMenu(context, appInfo, commands, globalFlags)`.
6. Route to the matched command via `context.commandName`; show help for unknown commands.

## Context Services

Prefer existing `CliContext` services over ad hoc utilities:

- `context.logger` for user-facing output and progress steps.
- `context.confirm()` for prompts; it respects `-y` / `--yes`.
- `context.config.loadConfig()` and `requireConfig()` for config loading.
- `context.fs` for project-rooted package info and file access.
- `context.packageManager` for install, add, run, and exec command strings.
- `context.framework` for detected framework/package metadata.
- `context.telemetry` for best-effort lifecycle and command events.
- `context.error` for normalized cancellation and error exits.

Extend `CliContext<TPackage>` when a product CLI injects app-specific services, but keep command implementations typed against the smallest context they need.

## Errors And UX

- Throw `CliError` for expected user-facing failures.
- Use `extendErrorCatalog` for product-specific error codes.
- Wrap top-level execution with `withErrorHandling` or use `context.error.handleError` for consistent rendering and telemetry.
- Use `displayIntro`, `createCliLogger`, `createSpinner`, `withSpinner`, and `showHelpMenu` for terminal UX.
- Do not print raw stack traces for expected CLI failures.

## Editing Hexbus

- If the user's workspace is a checkout of https://github.com/inthhq/hexbus, edit local files there. Otherwise, explain the relevant GitHub paths and provide patches or guidance against the upstream source.
- Keep public exports centralized in `packages/hexbus/src/index.ts` in the upstream repo.
- Add or update focused Vitest coverage when changing parser, context, detection, errors, telemetry, color, or update behavior.
- Preserve the framework-style boundary: shared CLI primitives belong in `hexbus`; product decisions belong in consuming packages.
- Prefer small explicit APIs over broad abstractions.
- Update `packages/hexbus/readie.json` in the upstream repo when README-facing docs change, then regenerate docs with the repo script.

## Bundled Resources

- Load `references/good-cli-checklist.md` when designing, reviewing, or improving CLI UX.
- Load `references/testing-hexbus-clis.md` when adding tests or planning coverage.
- Load `examples/cli-entrypoint.ts` when scaffolding a new production-style CLI entrypoint.

## Commands

When working in an upstream `hexbus` checkout, use Bun from that repo root:

- `bun run test --filter=hexbus`
- `bun run check-types --filter=hexbus`
- `bun run lint --filter=hexbus`
- `bun run build --filter=hexbus`
- `bun run readie`
- `bun x ultracite fix`
