import { readFile } from "node:fs/promises";

import { readSeries } from "./read-series.js";
import type { SeriesPatch } from "./read-series.js";

/**
 * Provenance for one series patch, read straight out of its mail headers.
 *
 * inrepo has no separate provenance manifest: a `git format-patch` file already
 * records who made the change, when, why, and which paths it touches.
 */
export interface SeriesPatchHeader {
  fileName: string;
  /** Absolute path to the patch file. */
  path: string;
  /** Numeric prefix of the file name. */
  index: number;
  /** Commit id from the leading `From <sha>` line, when the patch has one. */
  commit: string | null;
  authorName: string | null;
  authorEmail: string | null;
  /** Raw `Date:` header value, unparsed. */
  date: string | null;
  /** `Subject:` with the `[PATCH …]` prefix removed. */
  subject: string;
  /** Paths the patch touches, in the order git wrote them. */
  files: string[];
}

const FROM_LINE = /^From (?<g1>[0-9a-f]{7,64}) /u;
const PATCH_PREFIX = /^\[PATCH[^\]]*\]\s*/u;
const ENCODED_WORD = /[=]\?(?<g1>[^?]+)\?(?<g2>[bBqQ])\?(?<g3>[^?]*)\?=/gu;

const decodeBytes = function decodeBytes(
  bytes: number[],
  charset: string
): string {
  const lower = charset.toLowerCase();
  const label =
    lower === "iso-8859-1" || lower === "latin1" ? "latin1" : "utf-8";
  try {
    // SAFETY: value was parsed or constructed by the surrounding function before this assertion.
    return new TextDecoder(label as never).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
};

const decodeQuotedPrintableWord = function decodeQuotedPrintableWord(
  text: string,
  charset: string
): string {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char == null) {
      break;
    }
    if (char === "_") {
      bytes.push(0x20);
      continue;
    }
    if (char === "=" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push((char.codePointAt(0) ?? 0) & 0xff);
  }
  return decodeBytes(bytes, charset);
};

const decodeBase64Word = function decodeBase64Word(
  text: string,
  charset: string
): string {
  try {
    const binary = atob(text);
    const bytes: number[] = [];
    for (let i = 0; i < binary.length; i += 1) {
      bytes.push(binary.codePointAt(i) ?? 0);
    }
    return decodeBytes(bytes, charset);
  } catch {
    return text;
  }
};

/** Decode RFC 2047 encoded words, which git uses for non-ASCII header values. */
export const decodeHeaderValue = function decodeHeaderValue(
  value: string
): string {
  return value.replace(
    ENCODED_WORD,
    (_match, charset: string, encoding: string, text: string) =>
      encoding.toLowerCase() === "b"
        ? decodeBase64Word(text, charset)
        : decodeQuotedPrintableWord(text, charset)
  );
};

/**
 * Join a folded header. Git wraps long values by replacing a space with a
 * newline plus a space, except between encoded words, where the break carries
 * no space of its own.
 */
const unfold = function unfold(lines: string[]): string {
  let out = lines[0] ?? "";
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    out +=
      trimmed.startsWith("=?") && out.endsWith("?=") ? trimmed : ` ${trimmed}`;
  }
  return out;
};

const SIMPLE_ESCAPE_KEYS = [
  '"',
  "\\",
  "a",
  "b",
  "f",
  "n",
  "r",
  "t",
  "v",
] as const;
const SIMPLE_ESCAPE_VALUES = [34, 92, 7, 8, 12, 10, 13, 9, 11] as const;
const simpleEscape = function simpleEscape(char: string): number | undefined {
  const index = SIMPLE_ESCAPE_KEYS.indexOf(
    // SAFETY: char is a single-character look-up key into the fixed escape table.
    char as (typeof SIMPLE_ESCAPE_KEYS)[number]
  );
  return index === -1 ? undefined : SIMPLE_ESCAPE_VALUES[index];
};

/** Undo git's C-style path quoting (`"src/caf\303\251.ts"`). */
export const unquoteGitPath = function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") {
      const code = body.codePointAt(i) ?? 0;
      if (code < 0x80) {
        bytes.push(code);
      } else {
        for (const byte of new TextEncoder().encode(body[i])) {
          bytes.push(byte);
        }
      }
      continue;
    }
    i += 1;
    const escape = body[i];
    if (escape === undefined) {
      break;
    }
    if (/[0-7]/u.test(escape)) {
      const octal = body.slice(i, i + 3);
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += 2;
      continue;
    }
    bytes.push(simpleEscape(escape) ?? escape.codePointAt(0) ?? 0);
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
};

const stripSidePrefix = function stripSidePrefix(raw: string): string | null {
  const path = unquoteGitPath(raw.trim());
  if (path === "/dev/null") {
    return null;
  }
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
};

/**
 * Split `a/old b/new` from a `diff --git` line. Paths may contain spaces, so
 * the split is anchored on the last ` b/` that leaves a non-empty right side.
 */
const pathsFromDiffGitLine = function pathsFromDiffGitLine(
  rest: string
): string | null {
  if (rest.startsWith('"')) {
    const closing = /(?<!\\)"\s+/u.exec(rest.slice(1));
    if (closing) {
      const right = rest.slice(1 + closing.index + closing[0].length);
      return stripSidePrefix(right);
    }
  }
  const marker = rest.lastIndexOf(" b/");
  if (marker === -1) {
    return null;
  }
  return stripSidePrefix(rest.slice(marker + 1));
};

/** Paths touched by a patch, taken from its diff headers. */
const parseAffectedFiles = function parseAffectedFiles(
  lines: string[]
): string[] {
  const files: string[] = [];
  let fallback: string | null = null;
  let resolved: string | null = null;
  let inHunks = false;

  const flush = (): void => {
    const value = resolved ?? fallback;
    if (value != null && value !== "") {
      files.push(value);
    }
    fallback = null;
    resolved = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHunks = false;
      fallback = pathsFromDiffGitLine(line.slice("diff --git ".length));
      continue;
    }
    if (fallback == null && resolved == null) {
      continue;
    }
    // Hunk bodies can contain lines that look like diff headers ("--- x" is a
    // removed "-- x"), so header parsing stops at the first hunk.
    if (inHunks) {
      continue;
    }
    if (line.startsWith("@@ ") || line === "GIT binary patch") {
      inHunks = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      resolved = stripSidePrefix(line.slice(4)) ?? resolved;
      continue;
    }
    if (line.startsWith("--- ") && resolved == null) {
      resolved = stripSidePrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("rename to ")) {
      resolved = unquoteGitPath(line.slice("rename to ".length).trim());
    }
  }
  flush();

  return [...new Set(files)];
};

interface ParsedAuthor {
  name: string | null;
  email: string | null;
}

const parseAuthor = function parseAuthor(value: string): ParsedAuthor {
  const match = /^(?<g1>.*?)\s*<(?<g2>[^>]*)>\s*$/u.exec(value);
  if (!match) {
    return { email: null, name: value.trim() || null };
  }
  const name = match[1].trim().replace(/^"(?<g1>.*)"$/u, "$1");
  return { email: match[2].trim() || null, name: name || null };
};

/** Parse the mail headers and diff headers of one `git format-patch` file. */
export const parsePatchHeader = function parsePatchHeader(
  patch: Pick<SeriesPatch, "fileName" | "path" | "index">,
  content: string
): SeriesPatchHeader {
  const lines = content.split(/\r?\n/u);
  const commit = FROM_LINE.exec(lines[0] ?? "")?.[1] ?? null;

  const headers = new Map<string, string[]>();
  let current: string | null = null;
  let bodyStart = lines.length;
  for (let i = commit == null ? 0 : 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "") {
      bodyStart = i + 1;
      break;
    }
    if (/^[ \t]/u.test(line) && current != null) {
      headers.get(current)?.push(line);
      continue;
    }
    const match = /^(?<g1>[A-Za-z-]+):\s?(?<g2>.*)$/u.exec(line);
    if (!match) {
      bodyStart = i;
      break;
    }
    current = match[1].toLowerCase();
    headers.set(current, [match[2]]);
  }

  const header = (name: string): string | null => {
    const raw = headers.get(name);
    return raw == null ? null : decodeHeaderValue(unfold(raw));
  };

  const author = parseAuthor(header("from") ?? "");
  const subject = (header("subject") ?? "").replace(PATCH_PREFIX, "").trim();

  return {
    authorEmail: author.email,
    authorName: author.name,
    commit,
    date: header("date"),
    fileName: patch.fileName,
    files: parseAffectedFiles(lines.slice(bodyStart)),
    index: patch.index,
    path: patch.path,
    subject,
  };
};

/** Read and parse the provenance headers of a single patch file. */
export const readPatchHeader = async function readPatchHeader(
  patch: SeriesPatch
): Promise<SeriesPatchHeader> {
  return parsePatchHeader(patch, await readFile(patch.path, "utf-8"));
};

/** Read the provenance headers of a package's whole series, in apply order. */
export const readSeriesHeaders = async function readSeriesHeaders(
  seriesDir: string
): Promise<SeriesPatchHeader[]> {
  const patches = await readSeries(seriesDir);
  const headers: SeriesPatchHeader[] = [];
  for (const patch of patches) {
    headers.push(await readPatchHeader(patch));
  }
  return headers;
};
