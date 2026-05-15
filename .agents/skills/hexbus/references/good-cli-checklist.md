# Good Hexbus CLI Checklist

Use this when designing or reviewing a CLI built with `hexbus`.

## Command Shape

- Make command names stable, lowercase, and script-friendly: `init`, `doctor`, `sync`, `deploy`.
- Keep each `CliCommand` data-first: `name`, `label`, `hint`, `description`, `action`.
- Route from a single command table so help, menus, telemetry, and execution agree.
- Prefer explicit subcommands over flags that radically change behavior.
- Keep command actions small; move domain work into testable functions that accept plain inputs plus the narrow context services they need.

## Invocation Lifecycle

1. Read `process.argv.slice(2)` once.
2. Handle `-v` / `--version` before full context creation.
3. Create one `CliContext` with `createCliContext`.
4. Start background update checks only after context creation.
5. Show help before running command side effects.
6. Display an intro for interactive or multi-step commands.
7. Execute the command and let shared error handling render failures.

## Flags And Prompts

- Use built-in global flags unless the product needs command-specific parsing.
- Treat `--help`, `--version`, `--logger`, `--color`, `--config`, `--yes`, `--no-telemetry`, `--telemetry-debug`, and `--force` as reserved global behavior.
- Make destructive operations require confirmation unless `--yes` or `--force` clearly applies.
- Keep prompts skippable in CI or scripted use.
- Validate positional arguments before prompting.

## Output And UX

- Use `context.logger` for all user-facing output.
- Use `logger.step()` for multi-step workflows with meaningful step names.
- Use `withSpinner` or `createSpinner` for slow operations where progress is otherwise invisible.
- Print next actions after successful setup commands.
- Prefer concise success output over dumping implementation details.
- Keep debug details behind `--logger debug`.

## Configuration

- Use `context.config.loadConfig()` for optional config and `requireConfig()` when config is mandatory.
- Respect `--config <path>` through the context instead of implementing custom lookup.
- Report missing config with a `CliError` and a recovery hint.
- Write config through `context.fs` when it should be project-rooted.

## Errors

- Throw `CliError` for expected failures users can fix.
- Add product-specific errors with `extendErrorCatalog` during startup.
- Include hints that tell the user the next command or file to check.
- Avoid raw stack traces except in debug-oriented paths.
- Do not catch errors just to rethrow them.

## Good Defaults

- CLIs should work in the detected package manager by using `context.packageManager`.
- File operations should be rooted in `context.projectRoot` unless the command is explicitly cwd-based.
- Telemetry should be best-effort and never required for command success.
- Version and help output should be fast.
- Unknown commands should render help, not run a default mutating command.
