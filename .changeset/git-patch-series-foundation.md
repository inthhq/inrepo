---
'inrepo': minor
---

Add git patch series support. A package can now keep its committed changes as ordered `inrepo_patches/<package>/series/0001-*.patch` files, generated with `git format-patch --binary` and applied in filename order with `git am --3way` on top of the pinned upstream commit. `sync` and `verify` use the series when one exists and keep using legacy whole-file overlays otherwise, and the new `inrepo migrate <package>` command converts an overlay into a series after verifying that it reproduces the identical tree.
