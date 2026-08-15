import { Buffer } from "node:buffer";

import type { JsonObject, JsonValue } from "../json/unknown.js";
import { isJsonObject, isString } from "../json/unknown.js";
import { normalizeRepositoryUrlIdentity } from "./normalize-repository-url-identity.js";

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

interface AttestationRecord {
  predicateType?: JsonValue;
  bundle?: JsonValue;
}

interface InTotoStatement {
  subject?: { name?: JsonValue; digest?: JsonObject }[];
  predicateType?: JsonValue;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: { repository?: JsonValue };
      };
      resolvedDependencies?: {
        uri?: JsonValue;
        digest?: JsonObject;
      }[];
    };
  };
}

const integritySha512 = function integritySha512(
  integrity: string
): string | null {
  const match = /^sha512-(?<g1>[A-Za-z0-9+/]+={0,2})$/u.exec(integrity.trim());
  return match ? Buffer.from(match[1], "base64").toString("hex") : null;
};

const npmPurlName = function npmPurlName(name: string): string {
  if (!name.startsWith("@")) {
    return encodeURIComponent(name);
  }
  const slash = name.indexOf("/");
  return slash === -1
    ? encodeURIComponent(name)
    : `${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
};

const statementFromBundle = function statementFromBundle(
  bundle: JsonValue
): InTotoStatement {
  if (!isJsonObject(bundle)) {
    throw new Error("npm provenance bundle is not an object");
  }
  const envelopeValue = bundle.dsseEnvelope;
  if (!isJsonObject(envelopeValue) || !isString(envelopeValue.payload)) {
    throw new Error("npm provenance bundle has no DSSE payload");
  }
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  const parsed: JsonValue = JSON.parse(
    Buffer.from(envelopeValue.payload, "base64").toString("utf-8")
  ) as JsonValue;
  if (!isJsonObject(parsed)) {
    throw new Error("npm provenance statement is not an object");
  }
  // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
  return parsed as InTotoStatement;
};

const commitFromStatement = function commitFromStatement(
  statement: InTotoStatement,
  input: { name: string; version: string; gitUrl: string; integrity: string }
): string | null {
  if (statement.predicateType !== SLSA_PROVENANCE_V1) {
    return null;
  }
  const expectedDigest = integritySha512(input.integrity);
  if (!expectedDigest) {
    throw new Error(
      `Unsupported npm integrity for ${input.name}@${input.version}`
    );
  }
  const expectedSubject = `pkg:npm/${npmPurlName(input.name)}@${input.version}`;
  const subject = statement.subject?.find(
    (candidate) => candidate.name === expectedSubject
  );
  if (subject?.digest?.sha512 !== expectedDigest) {
    throw new Error(
      `npm provenance subject does not match ${input.name}@${input.version}`
    );
  }

  const build = statement.predicate?.buildDefinition;
  const workflowRepository = build?.externalParameters?.workflow?.repository;
  if (!isString(workflowRepository)) {
    throw new TypeError(
      `npm provenance for ${input.name}@${input.version} has no workflow repository`
    );
  }
  const expectedRepository = normalizeRepositoryUrlIdentity(input.gitUrl);
  const actualRepository = normalizeRepositoryUrlIdentity(workflowRepository);
  if (expectedRepository == null || actualRepository !== expectedRepository) {
    throw new Error(`npm provenance repository does not match ${input.gitUrl}`);
  }

  for (const dependency of build?.resolvedDependencies ?? []) {
    const commit = dependency.digest?.gitCommit;
    if (!isString(commit) || !/^[0-9a-f]{40}$/iu.test(commit)) {
      continue;
    }
    if (!isString(dependency.uri)) {
      continue;
    }
    const separator = dependency.uri.lastIndexOf("@");
    const repository =
      separator === -1 ? dependency.uri : dependency.uri.slice(0, separator);
    if (
      normalizeRepositoryUrlIdentity(repository.replace(/^git\+/u, "")) ===
      expectedRepository
    ) {
      return commit.toLowerCase();
    }
  }
  throw new Error(
    `npm provenance for ${input.name}@${input.version} has no source commit`
  );
};

/**
 * Read npm's registry-hosted SLSA statement and return the immutable source
 * commit it binds to the published tarball digest and advertised repository.
 * The registry transport is the trust boundary, matching npm's `gitHead`
 * metadata; every statement field is cross-checked before the commit is used.
 */
export const fetchNpmProvenanceCommit =
  async function fetchNpmProvenanceCommit(input: {
    name: string;
    version: string;
    gitUrl: string;
    integrity: string;
    attestationsUrl: string;
  }): Promise<string | null> {
    const response = await fetch(input.attestationsUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `npm provenance: HTTP ${response.status} for ${input.name}@${input.version}`
      );
    }
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const body = (await response.json()) as {
      attestations?: AttestationRecord[];
    };
    const record = body.attestations?.find(
      (candidate) => candidate.predicateType === SLSA_PROVENANCE_V1
    );
    if (record?.bundle == null || !isJsonObject(record.bundle)) {
      return null;
    }
    return commitFromStatement(statementFromBundle(record.bundle), input);
  };
