import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function validateDeletionPath(raw: string): string {
  const isDir = raw.endsWith('/');
  const body = isDir ? raw.slice(0, -1) : raw;
  if (body === '') {
    throw new Error('Deletion paths must not target the module root');
  }
  if (body.startsWith('/') || /^[A-Za-z]:[\\/]/.test(body)) {
    throw new Error(`Deletion path must be relative: ${JSON.stringify(raw)}`);
  }
  if (body.includes('\\')) {
    throw new Error(`Deletion path must use forward slashes: ${JSON.stringify(raw)}`);
  }
  const parts = body.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Deletion path must be a normal relative path: ${JSON.stringify(raw)}`);
  }
  return isDir ? `${body}/` : body;
}

export function normalizeDeletionEntries(entries: string[]): string[] {
  return [...new Set(entries.map(validateDeletionPath))].sort();
}

export function parseDeletionsFile(raw: string): string[] {
  const entries: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    entries.push(trimmed);
  }
  return normalizeDeletionEntries(entries);
}

export function serializeDeletionsFile(entries: string[]): string {
  const normalized = normalizeDeletionEntries(entries);
  if (normalized.length === 0) return '';
  return `${normalized.join('\n')}\n`;
}

export async function readDeletionsFile(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  return parseDeletionsFile(await readFile(path, 'utf8'));
}

export async function writeDeletionsFile(path: string, entries: string[]): Promise<void> {
  const serialized = serializeDeletionsFile(entries);
  if (serialized === '') {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
}
