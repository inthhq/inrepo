import nodePath from "node:path";

/**
 * Normalize npm `repository.directory` metadata to a safe POSIX path relative
 * to the repository root. The repository root itself is represented as null.
 */
export const normalizeRepositoryDirectory =
  function normalizeRepositoryDirectory(
    raw: string,
    label = "repository.directory"
  ): string | null {
    const trimmed = raw.trim();
    if (trimmed === "") {
      throw new Error(`${label} must be a non-empty relative path when set`);
    }
    if (trimmed.includes("\0")) {
      throw new Error(`${label} must not contain NUL bytes`);
    }
    if (trimmed.includes("\\")) {
      throw new Error(`${label} must use POSIX "/" separators`);
    }
    if (nodePath.isAbsolute(trimmed) || nodePath.win32.isAbsolute(trimmed)) {
      throw new Error(`${label} must be relative to the repository root`);
    }

    const parts = trimmed.split("/");
    if (parts.some((part) => part === "..")) {
      throw new Error(`${label} must not contain ".." traversal segments`);
    }

    const normalized = nodePath.posix
      .normalize(trimmed.replace(/^\.\/+/u, ""))
      .replace(/\/$/u, "");
    if (normalized === "." || normalized === "") {
      return null;
    }
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/")
    ) {
      throw new Error(`${label} must stay within the repository root`);
    }
    return normalized;
  };
