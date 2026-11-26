---
"inrepo": patch
---

Add `inrepo mirror` for publishing a filtered copy of part of your repository to another git repository, such as a public SDK repo. Declare `mirrors` in `inrepo.json` with a target `git` URL, `branch`, source `directory`, and `keep`/`exclude` lists (the same rules as vendored packages). Each run publishes the committed tree at `HEAD` or `--ref` as one commit on top of the target branch, carrying `Inrepo-Mirror-Source`, `Inrepo-Mirror-Tree` and `Inrepo-Mirror-Name` trailers, and never rewrites target history. It refuses to replace changes made directly on the target, or to roll the target back to an older source commit, unless you pass `--overwrite`. Submodules and non-UTF-8 paths are refused, and credentials in the target URL are hidden from output. `--dry-run` lists every change without pushing.
