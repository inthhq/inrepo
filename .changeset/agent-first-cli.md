---
"inrepo": minor
---

Make the CLI drivable by coding agents and scripts.

- `--json` on every command prints exactly one envelope on stdout, `{ "schemaVersion": 1, "ok": true, "command", "data" }` or `{ "schemaVersion": 1, "ok": false, "command", "error": { "code", "message", "hint", "nextCommand", "details" } }`, and sends all human output to stderr. Each command's `data` is a documented, typed result.
- Failures carry stable error codes (`USAGE`, `CONFIG_NOT_FOUND`, `CONFIG_INVALID`, `LOCKFILE_INVALID`, `PACKAGE_NOT_FOUND`, `UNCAPTURED_EDITS`, `UPDATE_CONFLICT`, `UPDATE_IN_PROGRESS`, `NO_UPDATE_IN_PROGRESS`, `PATCH_APPLY_FAILED`, `UPSTREAM_UNAVAILABLE`, `VERIFY_FAILED`, `ERROR`), and under `--json` the exit status tells the class of failure: usage, config, lockfile, and unknown-package errors exit 2; update conflicts, uncaptured edits, a paused update, and a patch that no longer applies exit 3; git remote, registry, and network failures exit 4; verify drift and unclassified errors exit 1. Without `--json`, every failure still exits 1, so existing scripts are unaffected.
- New read-only `inrepo status [<name>]` reports each package's pin, patches, uncaptured edits, and any paused update, with a `condition` and the `nextActions` that move it forward. It never fetches or writes.
- `--dry-run` for `add`, `sync`, `patch`, and `update` reports what would change without writing config, the lockfile, `package.json`, `inrepo_modules/`, `inrepo_patches/`, or inrepo state under `.inrepo/` (it may fill the gitignored download cache `.inrepo/cache/`). Other commands reject it. A short commit id passed as `--ref` previews as given in `add`/`sync`, and is a `USAGE` error in `update`, since a commit has no moving tip.
- `inrepo init --agents` adds a short inrepo rules block to the project's `AGENTS.md` (and to a `CLAUDE.md` that does not already defer to `AGENTS.md`). Reruns replace the block in place. If no config can be created (no terminal and no `INREPO_CONFIG`), it fails with `CONFIG_NOT_FOUND` before writing anything.
- `inrepo patch` still requires `-m "<reason>"` for every patch-series capture, in interactive and non-interactive sessions alike. A missing `-m` is now a `USAGE` error (exit 2) whose `nextCommand` is the exact command to run. Under `--dry-run`, `-m` is optional.
- The ASCII banner is no longer printed when stdout is not a TTY, under `--json`, or when a CI or coding-agent environment is detected.
- New docs pages, shipped in the package: `docs/agents.md` (the JSON contract, exit and error codes, the agent loop, and the update conflict loop) and `docs/commands.md` (every command's flags, writes, and JSON shape).
