import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { cleanupTmpDir, makeTmpDir } from '../test-utils/tmp-dir.js';
import { ensurePublishedArtifact, fillMissingPublishedFiles } from './published-artifact.js';

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function tar(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const body = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(body.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    octal([...header].reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function responseBody(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

describe('published npm artifacts', () => {
  let cwd: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(async () => {
    if (server) await server.stop(true);
    if (cwd) await cleanupTmpDir(cwd);
    cwd = undefined;
    server = undefined;
  });

  test('integrity-checks, caches, and fills only files absent from git', async () => {
    cwd = await makeTmpDir('inrepo-artifact-');
    const archive = tar({
      'package/src/index.ts': 'published source\n',
      'package/dist/index.js': 'published runtime\n',
      'package/package.json': '{"name":"example"}\n',
    });
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(responseBody(archive)),
    });
    const artifact = {
      tarballUrl: `http://127.0.0.1:${server.port}/example.tgz`,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    };

    const artifactRoot = await ensurePublishedArtifact(cwd, artifact);
    await server.stop(true);
    server = undefined;
    expect(await ensurePublishedArtifact(cwd, artifact)).toBe(artifactRoot);

    const target = join(cwd, 'target');
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src', 'index.ts'), 'git source\n');
    await fillMissingPublishedFiles(artifactRoot, target);

    expect(await readFile(join(target, 'src', 'index.ts'), 'utf8')).toBe('git source\n');
    expect(await readFile(join(target, 'dist', 'index.js'), 'utf8')).toBe('published runtime\n');
    expect(existsSync(join(target, '.artifact-meta.json'))).toBe(false);
  });

  test('rejects bytes that do not match the lock integrity', async () => {
    cwd = await makeTmpDir('inrepo-artifact-integrity-');
    const archive = tar({ 'package/index.js': 'export default 1;\n' });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(responseBody(archive)) });
    await expect(
      ensurePublishedArtifact(cwd, {
        tarballUrl: `http://127.0.0.1:${server.port}/bad.tgz`,
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      }),
    ).rejects.toThrow(/integrity mismatch/);
  });

  test('rejects tar entries outside the npm package root', async () => {
    cwd = await makeTmpDir('inrepo-artifact-path-');
    const archive = tar({ '../escape.js': 'bad\n' });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(responseBody(archive)) });
    await expect(
      ensurePublishedArtifact(cwd, {
        tarballUrl: `http://127.0.0.1:${server.port}/unsafe.tgz`,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      }),
    ).rejects.toThrow(/outside package root/);
    expect(existsSync(join(cwd, 'escape.js'))).toBe(false);
  });
});
