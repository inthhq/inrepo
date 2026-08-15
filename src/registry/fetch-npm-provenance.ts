import { Buffer } from 'node:buffer';
import { normalizeRepositoryUrlIdentity } from './normalize-repository-url-identity.js';

const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';

type AttestationRecord = {
  predicateType?: unknown;
  bundle?: unknown;
};

type InTotoStatement = {
  subject?: Array<{ name?: unknown; digest?: Record<string, unknown> }>;
  predicateType?: unknown;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: { repository?: unknown };
      };
      resolvedDependencies?: Array<{
        uri?: unknown;
        digest?: Record<string, unknown>;
      }>;
    };
  };
};

function integritySha512(integrity: string): string | null {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  return match ? Buffer.from(match[1], 'base64').toString('hex') : null;
}

function npmPurlName(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const slash = name.indexOf('/');
  return slash === -1
    ? encodeURIComponent(name)
    : `${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
}

function statementFromBundle(bundle: unknown): InTotoStatement {
  if (bundle == null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('npm provenance bundle is not an object');
  }
  const envelope = (bundle as { dsseEnvelope?: { payload?: unknown } }).dsseEnvelope;
  if (envelope == null || typeof envelope.payload !== 'string') {
    throw new Error('npm provenance bundle has no DSSE payload');
  }
  const parsed = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) as unknown;
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('npm provenance statement is not an object');
  }
  return parsed as InTotoStatement;
}

function commitFromStatement(
  statement: InTotoStatement,
  input: { name: string; version: string; gitUrl: string; integrity: string },
): string | null {
  if (statement.predicateType !== SLSA_PROVENANCE_V1) return null;
  const expectedDigest = integritySha512(input.integrity);
  if (!expectedDigest) throw new Error(`Unsupported npm integrity for ${input.name}@${input.version}`);
  const expectedSubject = `pkg:npm/${npmPurlName(input.name)}@${input.version}`;
  const subject = statement.subject?.find((candidate) => candidate.name === expectedSubject);
  if (subject?.digest?.sha512 !== expectedDigest) {
    throw new Error(`npm provenance subject does not match ${input.name}@${input.version}`);
  }

  const build = statement.predicate?.buildDefinition;
  const workflowRepository = build?.externalParameters?.workflow?.repository;
  if (typeof workflowRepository !== 'string') {
    throw new Error(`npm provenance for ${input.name}@${input.version} has no workflow repository`);
  }
  const expectedRepository = normalizeRepositoryUrlIdentity(input.gitUrl);
  const actualRepository = normalizeRepositoryUrlIdentity(workflowRepository);
  if (expectedRepository == null || actualRepository !== expectedRepository) {
    throw new Error(`npm provenance repository does not match ${input.gitUrl}`);
  }

  for (const dependency of build?.resolvedDependencies ?? []) {
    const commit = dependency.digest?.gitCommit;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) continue;
    if (typeof dependency.uri !== 'string') continue;
    const separator = dependency.uri.lastIndexOf('@');
    const repository = separator === -1 ? dependency.uri : dependency.uri.slice(0, separator);
    if (normalizeRepositoryUrlIdentity(repository.replace(/^git\+/, '')) === expectedRepository) {
      return commit.toLowerCase();
    }
  }
  throw new Error(`npm provenance for ${input.name}@${input.version} has no source commit`);
}

/**
 * Read npm's registry-hosted SLSA statement and return the immutable source
 * commit it binds to the published tarball digest and advertised repository.
 * The registry transport is the trust boundary, matching npm's `gitHead`
 * metadata; every statement field is cross-checked before the commit is used.
 */
export async function fetchNpmProvenanceCommit(input: {
  name: string;
  version: string;
  gitUrl: string;
  integrity: string;
  attestationsUrl: string;
}): Promise<string | null> {
  const response = await fetch(input.attestationsUrl, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`npm provenance: HTTP ${response.status} for ${input.name}@${input.version}`);
  }
  const body = (await response.json()) as { attestations?: AttestationRecord[] };
  const record = body.attestations?.find(
    (candidate) => candidate.predicateType === SLSA_PROVENANCE_V1,
  );
  if (record?.bundle == null || typeof record.bundle !== 'object') return null;
  return commitFromStatement(statementFromBundle(record.bundle), input);
}
