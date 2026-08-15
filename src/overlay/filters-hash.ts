import { createHash } from "node:crypto";

const sortedUnique = function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].toSorted();
};

export const filtersHash = function filtersHash(
  keep: string[],
  exclude: string[]
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        exclude: sortedUnique(exclude),
        keep: sortedUnique(keep),
      }),
      "utf-8"
    )
    .digest("hex");
};
