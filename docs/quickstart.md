---
title: Quickstart
description: 'Initialize inrepo, add a package, capture changes, and verify the result.'
group: get-started
---
# Quickstart

Run from a project that wants to vendor upstream packages:

```bash
npx inrepo --help
```

Initialize config explicitly, or let the first `sync` or `add` prompt for where config should live:

```bash
inrepo init
```

Add and pin a package:

```bash
inrepo add <name>
```

If the npm registry package does not expose a GitHub repository URL, pass the git URL:

```bash
inrepo add <name> --git https://github.com/owner/repo --ref main
```

The normal collaboration loop is:

1. Run `inrepo sync` to rebuild generated modules from `inrepo.lock.json` and `inrepo_patches/`.
2. Edit files under `inrepo_modules/<name>/`.
3. Run `inrepo patch <name>` to capture those edits into `inrepo_patches/<name>/`.
4. Commit config, lockfile changes, and patch files.
5. Teammates pull and run `inrepo sync`.

Before merging, run:

```bash
inrepo verify
```

`verify` checks that generated module trees still match the lockfile plus committed overlay.
