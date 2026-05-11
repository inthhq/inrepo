---
title: Overview
description: What inrepo does and how to think about its generated files.
group: get-started
---
# inrepo

`inrepo` vendors upstream git repositories into `inrepo_modules/` from declarative config. It is for teams that need upstream code in the repo tree, pinned and reviewable, without maintaining git submodules or a long-lived fork.

The important state is split into three layers:

* `inrepo.lock.json` pins the exact upstream commit for each module.
* `inrepo_patches/<name>/` stores your team's committed overlay files and deletions.
* `inrepo_modules/<name>/` is generated output rebuilt from the lockfile plus overlay.

Keep `inrepo_modules/` and `.inrepo/` in `.gitignore`. Commit `inrepo.json` or `package.json#inrepo`, `inrepo.lock.json` when pins change, and `inrepo_patches/` when your team changes vendored code.

Use `inrepo verify` in CI to catch a checkout that no longer matches the lockfile and overlay.
