import nodePath from "node:path";

/** Resolve `relPosix` under `destRoot` and ensure it stays inside the vendor tree. */
export const assertSafeUnderDest = function assertSafeUnderDest(
  destRoot: string,
  relPosix: string
): string {
  const abs = nodePath.resolve(destRoot, ...relPosix.split("/"));
  const rel = nodePath.relative(destRoot, abs);
  if (rel === "") {
    throw new Error(
      `Refusing to use the entire vendor directory as a path: ${JSON.stringify(relPosix)}`
    );
  }
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(
      `Unsafe path (outside vendor dir): ${JSON.stringify(relPosix)}`
    );
  }
  return abs;
};
