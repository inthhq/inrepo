import { afterEach, describe, expect, test } from 'bun:test';
import { fetchNpmProvenanceCommit } from './fetch-npm-provenance.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function bundle(input: {
  name?: string;
  version?: string;
  repository?: string;
  commit?: string;
  digest?: string;
} = {}): unknown {
  const name = input.name ?? '@scope/pkg';
  const version = input.version ?? '1.2.3';
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `pkg:npm/${name.startsWith('@') ? `${encodeURIComponent(name.split('/')[0])}/${name.split('/')[1]}` : encodeURIComponent(name)}@${version}`,
        digest: { sha512: input.digest ?? Buffer.from('abc').toString('hex') },
      },
    ],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { repository: input.repository ?? 'https://github.com/test/repo' },
        },
        resolvedDependencies: [
          {
            uri: `${input.repository ?? 'git+https://github.com/test/repo'}@refs/heads/main`,
            digest: { gitCommit: input.commit ?? 'a'.repeat(40) },
          },
        ],
      },
    },
  };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } };
}

describe('fetchNpmProvenanceCommit', () => {
  test('binds package, version, tarball digest, repository, and commit', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            attestations: [
              { predicateType: 'https://slsa.dev/provenance/v1', bundle: bundle() },
            ],
          }),
        ),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    expect(
      await fetchNpmProvenanceCommit({
        name: '@scope/pkg',
        version: '1.2.3',
        gitUrl: 'https://github.com/test/repo.git',
        integrity: 'sha512-YWJj',
        attestationsUrl: 'https://registry.example/attestations',
      }),
    ).toBe('a'.repeat(40));
  });

  test('rejects a statement for a different repository', async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            attestations: [
              {
                predicateType: 'https://slsa.dev/provenance/v1',
                bundle: bundle({ repository: 'https://github.com/attacker/repo' }),
              },
            ],
          }),
        ),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    await expect(
      fetchNpmProvenanceCommit({
        name: '@scope/pkg',
        version: '1.2.3',
        gitUrl: 'https://github.com/test/repo.git',
        integrity: 'sha512-YWJj',
        attestationsUrl: 'https://registry.example/attestations',
      }),
    ).rejects.toThrow(/repository does not match/);
  });
});
