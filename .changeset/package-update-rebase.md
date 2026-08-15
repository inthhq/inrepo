---
"inrepo": minor
---

Update a vendored package by rebasing its patch series. `inrepo update <package> [--ref <ref>]` re-resolves the pinned ref, replays the committed series onto the new upstream commit in an isolated scratch repository, and only then rewrites the series (renumbered from `0001`, with each patch's original subject, author, and date preserved), the config ref, `inrepo.lock.json`, and the generated module. Patches upstream has since adopted are dropped. Conflicts stop the update with the failing patch subject and the conflicted paths, keeping the half-finished rebase under `.inrepo/updates/<package>/repo` for `inrepo update <package> --continue` or `--abort`, and leaving every committed file untouched. Packages with no patches are re-pinned and rebuilt; packages still on the legacy whole-file overlay are told to run `inrepo migrate` first.
