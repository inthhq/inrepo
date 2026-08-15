---
"inrepo": patch
---

Resolve registry packages to immutable source commits using npm `gitHead`, matching release tags, or registry-hosted npm provenance cross-checked against the tarball digest and repository, and discover missing monorepo package directories from the pinned checkout. `inrepo add --with-deps` now gives transitive packages versioned module identities so incompatible versions can coexist, records exact graph edges in lockfile version 4, and replays each instance through sync, verify, diff, patch, and import rewiring.
