---
name: inrepo
description: Vendor, patch, update, and verify upstream packages with the inrepo CLI. Use when a project has inrepo.json, inrepo.lock.json, inrepo_modules/, or inrepo_patches/, or when you need to change a vendored dependency's source.
---

# Working with inrepo

inrepo pins upstream git repositories to exact commits and rebuilds `inrepo_modules/<name>/` from `inrepo.lock.json` plus the committed patches in `inrepo_patches/<name>/`. Run it as `npx inrepo` when `inrepo` is not on PATH.

## Golden rules

- `inrepo_modules/` is generated. Edit files there, then run `inrepo patch <name> -m "<reason>"` before any `sync`, `update`, or `add`, or the edits are lost.
- `-m` is required. Each `patch` run appends one numbered patch; give one reason per logical change.
- Never hand-edit `inrepo.lock.json` or `inrepo_patches/**/*.patch`. Move pins with `inrepo update` or `inrepo add --ref`; change patches by editing the checkout and capturing again.
- `inrepo sync --force` discards uncaptured edits (a backup goes to `.inrepo/backups/`). Do not use it to get past `UNCAPTURED_EDITS` unless discarding is intended.
- Commit the config, `inrepo.lock.json`, and `inrepo_patches/`. Never commit `inrepo_modules/` or `.inrepo/`.

## Agent loop

```bash
inrepo status --json                     # 1. state; follow nextActions of non-clean packages
# 2. act: edit inrepo_modules/<name>/, or inrepo add/sync/update ... --json
inrepo patch <name> -m "<reason>" --json # 3. capture edits
inrepo diff <name> --stat --json         #    optional review of the committed delta
inrepo verify --json                     # 4. must exit 0 before you finish
```

Preview `add`, `sync`, `patch`, `update`, or `mirror` with `--dry-run`. It writes no config, lockfile, `package.json`, checkout, or patch.

## Reading results

With `--json`, stdout is exactly one envelope; human output goes to stderr.

- Success: `{ "schemaVersion": 1, "ok": true, "command": "...", "data": { ... } }`
- Failure: `{ "schemaVersion": 1, "ok": false, "command": "...", "error": { "code", "message", "hint", "nextCommand", "details" } }`

Always pass `--json`. Branch on `error.code` and the exit code (exit classes apply only under `--json`; without it every failure exits 1), never on message text:

| Exit | Meaning | Common codes |
| --- | --- | --- |
| 0 | ok |  |
| 1 | check failed or unclassified | `VERIFY_FAILED`, `ERROR` |
| 2 | fix the command or input | `USAGE`, `CONFIG_NOT_FOUND`, `CONFIG_INVALID`, `LOCKFILE_INVALID`, `PACKAGE_NOT_FOUND`, `NO_UPDATE_IN_PROGRESS`, `MIRROR_NOT_FOUND`, `MIRROR_HISTORY_MISSING` |
| 3 | needs resolution | `UNCAPTURED_EDITS`, `UPDATE_CONFLICT`, `UPDATE_IN_PROGRESS`, `PATCH_APPLY_FAILED`, `MIRROR_TARGET_CHANGED` |
| 4 | upstream or network; retry | `UPSTREAM_UNAVAILABLE` |

`error.nextCommand` is a suggestion with placeholders such as `<reason>`; fill them in and read `hint` first. For `UNCAPTURED_EDITS`, run `inrepo patch <name> -m "<reason>"`.

## Update conflict loop

1. `inrepo status <name> --json` shows `condition: "clean"`. Capture edits first otherwise.
2. `inrepo update <name> --json`. Exit 0 means done; go to step 5.
3. Exit 3 with `UPDATE_CONFLICT`: for each path in `error.details.conflictedFiles`, edit `<error.details.repoPath>/<path>` and remove every conflict marker, keeping the intent of both upstream and the patch in `error.details.patch`. Do not run git commands there, and do not touch `inrepo_modules/`.
4. `inrepo update <name> --continue --json`. Exit 3 with `UPDATE_CONFLICT` again means markers remain or a later patch conflicts: repeat step 3. To give up, run `inrepo update <name> --abort --json`; nothing outside `.inrepo/` changed.
5. `inrepo verify --json`, then commit `inrepo_patches/<name>/series/`, `inrepo.lock.json`, and the config.

## Mirrors

A `mirrors` entry publishes a filtered copy of a committed directory to another repository, such as a public SDK repo.

- Preview first: `inrepo mirror <name> --dry-run --json`. Check that `data.mirrors[].changes` lists no tests or internal files before you publish.
- Then publish: `inrepo mirror <name> --json`.
- Commit `inrepo.json` before mirroring; the run refuses when the config on disk differs from the committed one.
- `MIRROR_TARGET_CHANGED` (exit 3) means someone changed the target or another mirror wrote it. Do not pass `--overwrite` on your own: ask a person, because it replaces those changes.

## Non-interactive sessions

No TTY, `CI=true`, `INREPO_NONINTERACTIVE=1`, or `--json` disables prompts. First-time setup then needs `INREPO_CONFIG=inrepo.json` (or `package.json`), for example `INREPO_CONFIG=inrepo.json inrepo init`. `inrepo init --agents` adds these rules to the project's `AGENTS.md`.

## More detail

- `../../AGENTS.md` (package root) indexes the bundled docs, version-matched to this package.
- `../../docs/agents.md`: envelope, every error code, dry-run rules, the conflict loop with a full payload.
- `../../docs/commands.md`: each command's flags, writes, and JSON `data` shape.
