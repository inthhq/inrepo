import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { isJsonObject, isString } from "../json/unknown.js";
import type { PublishedArtifact } from "../types/published-artifact.js";
import {
  artifactCacheDirPath,
  artifactCacheRootPath,
} from "./overlay-paths.js";
import { relPosixToAbs, walkTree } from "./tree-utils.js";

const gunzipAsync = promisify(gunzip);
const META_FILE = ".artifact-meta.json";
const MAX_TARBALL_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;

type ArtifactMeta = PublishedArtifact;

interface IntegrityParts {
  algorithm: string;
  digest: string;
}

const integrityParts = function integrityParts(
  integrity: string
): IntegrityParts {
  const tokens = integrity.trim().split(/\s+/u);
  const preferred =
    tokens.find((token) => token.startsWith("sha512-")) ?? tokens[0];
  const match = /^(?<g1>[a-z0-9]+)-(?<g2>[A-Za-z0-9+/]+={0,2})$/iu.exec(
    preferred ?? ""
  );
  if (!match) {
    throw new Error(`Unsupported npm artifact integrity: ${integrity}`);
  }
  return { algorithm: match[1].toLowerCase(), digest: match[2] };
};

const artifactKey = function artifactKey(artifact: PublishedArtifact): string {
  return createHash("sha256").update(artifact.integrity).digest("hex");
};

const verifyIntegrity = function verifyIntegrity(
  bytes: Uint8Array,
  integrity: string
): void {
  const expected = integrityParts(integrity);
  let actual: string;
  try {
    actual = createHash(expected.algorithm).update(bytes).digest("base64");
  } catch {
    throw new Error(
      `Unsupported npm artifact integrity algorithm: ${expected.algorithm}`
    );
  }
  if (actual !== expected.digest) {
    throw new Error(`npm artifact integrity mismatch: expected ${integrity}`);
  }
};

const tarString = function tarString(
  bytes: Uint8Array,
  start: number,
  length: number
): string {
  const slice = bytes.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return new TextDecoder().decode(
    zero === -1 ? slice : slice.subarray(0, zero)
  );
};

const tarNumber = function tarNumber(
  bytes: Uint8Array,
  start: number,
  length: number
): number {
  const raw = tarString(bytes, start, length).trim().replace(/\0.*$/u, "");
  if (raw === "") {
    return 0;
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid npm artifact tar size: ${raw}`);
  }
  return value;
};

const paxPath = function paxPath(payload: Uint8Array): string | null {
  const text = new TextDecoder().decode(payload);
  let cursor = 0;
  let path: string | null = null;
  while (cursor < text.length) {
    const space = text.indexOf(" ", cursor);
    if (space === -1) {
      break;
    }
    const length = Math.trunc(Number(text.slice(cursor, space)));
    if (!Number.isSafeInteger(length) || length <= 0) {
      break;
    }
    const record = text.slice(space + 1, cursor + length).replace(/\n$/u, "");
    const equals = record.indexOf("=");
    if (equals !== -1 && record.slice(0, equals) === "path") {
      path = record.slice(equals + 1);
    }
    cursor += length;
  }
  return path;
};

const packageRelativePath = function packageRelativePath(
  raw: string
): string | null {
  const normalized = raw
    .replace(/\0.*$/u, "")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  if (normalized === "package" || normalized === "") {
    return null;
  }
  if (!normalized.startsWith("package/")) {
    throw new Error(`Unsafe npm artifact entry outside package root: ${raw}`);
  }
  const relative = nodePath.posix.normalize(
    normalized.slice("package/".length)
  );
  if (
    relative === "" ||
    relative === "." ||
    relative.startsWith("/") ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("\\")
  ) {
    throw new Error(`Unsafe npm artifact path: ${raw}`);
  }
  return relative;
};

const extractNpmTarball = async function extractNpmTarball(
  bytes: Uint8Array,
  target: string
): Promise<void> {
  const tar = new Uint8Array(
    await gunzipAsync(bytes, { maxOutputLength: MAX_EXTRACTED_BYTES })
  );
  let offset = 0;
  let nextPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = tarNumber(header, 124, 12);
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > tar.length) {
      throw new Error("Truncated npm artifact tarball");
    }
    const type = String.fromCodePoint(header[156] || 48);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const payload = tar.subarray(payloadStart, payloadEnd);

    if (type === "x") {
      nextPath = paxPath(payload);
    } else if (type === "L") {
      nextPath = tarString(payload, 0, payload.length);
    } else {
      const relative = packageRelativePath(nextPath ?? headerPath);
      nextPath = null;
      if (relative != null) {
        const destination = relPosixToAbs(target, relative);
        if (type === "5") {
          await mkdir(destination, { recursive: true });
        } else if (type === "0" || type === "\0") {
          await mkdir(nodePath.dirname(destination), { recursive: true });
          await writeFile(destination, payload);
          const mode = tarNumber(header, 100, 8);
          await chmod(destination, mode & 0o111 ? 0o755 : 0o644);
        } else if (type === "1" || type === "2") {
          throw new Error(`Refusing link in npm artifact: ${relative}`);
        }
      }
    }
    offset = payloadStart + Math.ceil(size / 512) * 512;
  }
};

const readMeta = async function readMeta(
  dir: string
): Promise<ArtifactMeta | null> {
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    const parsed = JSON.parse(
      await readFile(nodePath.join(dir, META_FILE), "utf-8")
    ) as unknown;
    if (!isJsonObject(parsed)) {
      return null;
    }
    const rec = parsed;
    if (!isString(rec.tarballUrl) || !isString(rec.integrity)) {
      return null;
    }
    return { integrity: rec.integrity, tarballUrl: rec.tarballUrl };
  } catch {
    return null;
  }
};

/** Download, integrity-check, and cache one npm package payload. */
export const ensurePublishedArtifact = async function ensurePublishedArtifact(
  cwd: string,
  artifact: PublishedArtifact
): Promise<string> {
  integrityParts(artifact.integrity);
  const target = artifactCacheDirPath(cwd, artifactKey(artifact));
  const cached = await readMeta(target);
  if (
    cached?.integrity === artifact.integrity &&
    cached.tarballUrl === artifact.tarballUrl
  ) {
    return target;
  }

  const response = await fetch(artifact.tarballUrl);
  if (!response.ok) {
    throw new Error(
      `npm artifact: HTTP ${response.status} for ${artifact.tarballUrl}`
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TARBALL_BYTES) {
    throw new Error(
      `npm artifact is too large (${declaredLength} bytes): ${artifact.tarballUrl}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_TARBALL_BYTES) {
    throw new Error(
      `npm artifact is too large (${bytes.byteLength} bytes): ${artifact.tarballUrl}`
    );
  }
  verifyIntegrity(bytes, artifact.integrity);

  const root = artifactCacheRootPath(cwd);
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(nodePath.join(root, ".tmp-"));
  try {
    await extractNpmTarball(bytes, stage);
    await writeFile(
      nodePath.join(stage, META_FILE),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf-8"
    );
    await rm(target, { force: true, recursive: true });
    await rename(stage, target);
    return target;
  } catch (error) {
    await rm(stage, { force: true, recursive: true });
    throw error;
  }
};

const hasBlockingAncestor = async function hasBlockingAncestor(
  target: string,
  relative: string
): Promise<boolean> {
  const segments = relative.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = nodePath.join(target, ...segments.slice(0, index));
    if (!existsSync(ancestor)) {
      continue;
    }
    if (!(await (await lstat(ancestor)).isDirectory())) {
      return true;
    }
  }
  return false;
};

/** Fill files absent from the git checkout; repository content always wins. */
export const fillMissingPublishedFiles =
  async function fillMissingPublishedFiles(
    artifactRoot: string,
    target: string
  ): Promise<void> {
    const entries = await walkTree(artifactRoot, {
      skip: (relative) => relative === META_FILE,
    });
    for (const relative of [...entries.keys()].toSorted()) {
      const entry = entries.get(relative);
      if (
        entry?.kind !== "file" ||
        existsSync(relPosixToAbs(target, relative))
      ) {
        continue;
      }
      if (await hasBlockingAncestor(target, relative)) {
        continue;
      }
      const destination = relPosixToAbs(target, relative);
      await mkdir(nodePath.dirname(destination), { recursive: true });
      await copyFile(relPosixToAbs(artifactRoot, relative), destination);
      await chmod(destination, entry.executable ? 0o755 : 0o644);
    }
  };
