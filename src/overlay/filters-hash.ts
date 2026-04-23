import { createHash } from 'node:crypto';

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function filtersHash(keep: string[], exclude: string[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        keep: sortedUnique(keep),
        exclude: sortedUnique(exclude),
      }),
      'utf8',
    )
    .digest('hex');
}
