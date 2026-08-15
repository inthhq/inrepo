import { afterEach, describe, expect, test } from "bun:test";

import { fetchNpmProvenanceCommit } from "./fetch-npm-provenance.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface ProvenanceTestBundle {
  dsseEnvelope: {
    payload: string;
  };
}

const bundle = function bundle(
  input: {
    name?: string;
    version?: string;
    repository?: string;
    commit?: string;
    digest?: string;
  } = {}
): ProvenanceTestBundle {
  const name = input.name ?? "@scope/pkg";
  const version = input.version ?? "1.2.3";
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: input.repository ?? "https://github.com/test/repo",
          },
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: input.commit ?? "a".repeat(40) },
            uri: `${input.repository ?? "git+https://github.com/test/repo"}@refs/heads/main`,
          },
        ],
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        digest: { sha512: input.digest ?? Buffer.from("abc").toString("hex") },
        name: `pkg:npm/${name.startsWith("@") ? `${encodeURIComponent(name.split("/")[0])}/${name.split("/")[1]}` : encodeURIComponent(name)}@${version}`,
      },
    ],
  };
  return {
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
    },
  };
};

const installFetch = function installFetch(
  impl: () => Promise<Response> | Response
): void {
  const fetchImpl = Object.assign(
    (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(impl()),
    { preconnect: originalFetch.preconnect }
  );
  globalThis.fetch = fetchImpl;
};

describe("fetchNpmProvenanceCommit", () => {
  test("binds package, version, tarball digest, repository, and commit", async () => {
    installFetch(() =>
      Response.json({
        attestations: [
          {
            bundle: bundle(),
            predicateType: "https://slsa.dev/provenance/v1",
          },
        ],
      })
    );
    expect(
      await fetchNpmProvenanceCommit({
        attestationsUrl: "https://registry.example/attestations",
        gitUrl: "https://github.com/test/repo.git",
        integrity: "sha512-YWJj",
        name: "@scope/pkg",
        version: "1.2.3",
      })
    ).toBe("a".repeat(40));
  });

  test("rejects a statement for a different repository", async () => {
    installFetch(() =>
      Response.json({
        attestations: [
          {
            bundle: bundle({
              repository: "https://github.com/attacker/repo",
            }),
            predicateType: "https://slsa.dev/provenance/v1",
          },
        ],
      })
    );
    await expect(
      fetchNpmProvenanceCommit({
        attestationsUrl: "https://registry.example/attestations",
        gitUrl: "https://github.com/test/repo.git",
        integrity: "sha512-YWJj",
        name: "@scope/pkg",
        version: "1.2.3",
      })
    ).rejects.toThrow(/repository does not match/u);
  });
});
