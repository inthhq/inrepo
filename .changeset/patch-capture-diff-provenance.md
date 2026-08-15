---
"inrepo": minor
---

Capture patches with a reason and review them. `inrepo patch <package> -m "reason"` now appends the current edits in `inrepo_modules/<package>` to the package's patch series as the next numbered `git format-patch` file, using the message as the patch subject; each invocation writes a new patch, and an unchanged module reports that there is nothing to capture. New packages start on the series format, while packages that still carry whole-file snapshots keep the original overlay capture. The new `inrepo diff [package] [--stat]` command renders the effective delta from the pinned upstream commit to the patched tree with git, so deletions, mode changes, symlinks, and binary files all read correctly, and lists each patch's subject, author, and date as the provenance record.
