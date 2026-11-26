---
"inrepo": patch
---

Add `inrepo mirror` for publishing a filtered copy of part of your repository to another git repository, such as a public SDK repo. Declare `mirrors` in `inrepo.json` with a target `git` URL, `branch`, source `directory`, and `keep`/`exclude` lists (the same rules as vendored packages). Each run publishes the committed tree at `HEAD` or `--ref` as one fast-forward commit carrying an `Inrepo-Mirror-Source` trailer, and never force-pushes. It refuses to replace commits made directly on the target, or to roll the target back to an older source commit, unless you pass `--overwrite`. `--dry-run` lists every change without pushing.
