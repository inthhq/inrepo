import { afterEach, describe, expect, test } from "bun:test";

import type { JsonObject } from "../json/unknown.js";
import { packumentUrl, registryBaseUrl } from "./fetch-packument.js";
import { toRegistryPackage } from "./load-registry-package.js";

describe("registry base URL", () => {
  const original = process.env.INREPO_REGISTRY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.INREPO_REGISTRY;
    } else {
      process.env.INREPO_REGISTRY = original;
    }
  });

  test("defaults to the public npm registry", () => {
    delete process.env.INREPO_REGISTRY;
    expect(registryBaseUrl()).toBe("https://registry.npmjs.org");
    expect(packumentUrl("@scope/pkg")).toBe(
      "https://registry.npmjs.org/%40scope%2Fpkg"
    );
  });

  test("honors INREPO_REGISTRY and trims trailing slashes", () => {
    process.env.INREPO_REGISTRY = "http://127.0.0.1:1234/";
    expect(packumentUrl("pkg")).toBe("http://127.0.0.1:1234/pkg");
  });

  test("falls back to the default when the override is blank", () => {
    process.env.INREPO_REGISTRY = "   ";
    expect(registryBaseUrl()).toBe("https://registry.npmjs.org");
  });
});

describe("toRegistryPackage", () => {
  test("keeps runtime dependencies and drops dev and peer ones", () => {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const pkg = toRegistryPackage("beta", {
      repository: "https://github.com/test/beta",
      versions: {
        "1.0.0": {
          dependencies: { gamma: "^2.0.0" },
          devDependencies: { typescript: "^5" },
          peerDependencies: { react: "^18" },
        } as JsonObject,
      },
    });
    expect(pkg.manifests).toEqual([
      {
        artifact: null,
        attestationsUrl: null,
        dependencies: { gamma: "^2.0.0" },
        distIntegrity: null,
        gitHead: null,
        gitUrl: "https://github.com/test/beta.git",
        repositoryDirectory: null,
        version: "1.0.0",
      },
    ]);
  });

  test("prefers a per-version repository over the packument one", () => {
    const pkg = toRegistryPackage("beta", {
      repository: "https://github.com/test/old",
      versions: {
        "1.0.0": {
          repository: { url: "git+ssh://git@github.com/test/new.git" },
        },
      },
    });
    expect(pkg.manifests[0].gitUrl).toBe("https://github.com/test/new.git");
  });

  test("preserves repository.directory and version-level overrides", () => {
    const pkg = toRegistryPackage("@scope/cli", {
      repository: {
        directory: "./packages/cli/",
        url: "https://github.com/test/workspace",
      },
      versions: {
        "1.0.0": {},
        "2.0.0": {
          repository: {
            directory: "packages/cli-v2",
            url: "https://github.com/test/workspace",
          },
        },
        "3.0.0": { repository: "https://github.com/test/standalone" },
      },
    });
    expect(
      pkg.manifests.map((manifest) => manifest.repositoryDirectory)
    ).toEqual(["packages/cli", "packages/cli-v2", null]);
  });

  test("rejects unsafe repository.directory metadata", () => {
    expect(() =>
      toRegistryPackage("beta", {
        repository: {
          directory: "../beta",
          url: "https://github.com/test/workspace",
        },
        versions: { "1.0.0": {} },
      })
    ).toThrow(/repository\.directory.*traversal/u);
  });

  test("reports a null git URL when there is no usable repository", () => {
    expect(
      toRegistryPackage("beta", { versions: { "1.0.0": {} } }).manifests[0]
        .gitUrl
    ).toBeNull();
    expect(
      toRegistryPackage("beta", {
        repository: "gist:abc123",
        versions: { "1.0.0": {} },
      }).manifests[0].gitUrl
    ).toBeNull();
  });

  test("accepts non-GitHub clone URLs, unlike the single-package resolver", () => {
    expect(
      toRegistryPackage("beta", {
        repository: "https://gitlab.com/test/beta.git",
        versions: { "1.0.0": {} },
      }).manifests[0].gitUrl
    ).toBe("https://gitlab.com/test/beta.git");
  });

  test("tolerates a packument with no versions", () => {
    expect(toRegistryPackage("beta", {}).manifests).toEqual([]);
  });

  test("ignores non-string dependency specifiers", () => {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const pkg = toRegistryPackage("beta", {
      versions: {
        "1.0.0": { dependencies: { gamma: 1 } as JsonObject },
      },
    });
    expect(pkg.manifests[0].dependencies).toEqual({});
  });

  test("retains immutable publish provenance for pin fallbacks", () => {
    const pkg = toRegistryPackage("beta", {
      versions: {
        "1.0.0": {
          dist: {
            attestations: {
              url: "https://registry.example/attestations/beta@1.0.0",
            },
            integrity: "sha512-YWJj",
          },
          gitHead: "A".repeat(40),
          repository: "https://github.com/test/beta",
        },
      },
    });
    expect(pkg.manifests[0]).toMatchObject({
      artifact: null,
      attestationsUrl: "https://registry.example/attestations/beta@1.0.0",
      distIntegrity: "sha512-YWJj",
      gitHead: "a".repeat(40),
    });
  });

  test("retains the integrity-pinned npm tarball as a published artifact", () => {
    const pkg = toRegistryPackage("beta", {
      versions: {
        "1.0.0": {
          dist: {
            integrity: "sha512-YWJj",
            tarball: "https://registry.npmjs.org/beta/-/beta-1.0.0.tgz",
          },
        },
      },
    });
    expect(pkg.manifests[0].artifact).toEqual({
      integrity: "sha512-YWJj",
      tarballUrl: "https://registry.npmjs.org/beta/-/beta-1.0.0.tgz",
    });
  });
});
