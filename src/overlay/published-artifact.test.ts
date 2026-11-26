import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import nodePath from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { isString } from "../json/unknown.js";
import { cleanupTmpDir, makeTmpDir } from "../test-utils/tmp-dir.js";
import {
  ensurePublishedArtifact,
  fillMissingPublishedFiles,
} from "./published-artifact.js";

const octal = function octal(value: number, length: number): Buffer {
  return Buffer.from(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    "ascii"
  );
};

const tar = function tar(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const body = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf-8");
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(body.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = "0".codePointAt(0) ?? 0;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(
      [...header].reduce((sum, byte) => sum + byte, 0),
      8
    ).copy(header, 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
};

const startArchiveServer = async function startArchiveServer(
  archive: Buffer
): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end(archive);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address == null || isString(address)) {
    throw new Error("Expected TCP address for artifact server");
  }
  return { port: address.port, server };
};

const stopServer = async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
};

describe("published npm artifacts", () => {
  let cwd: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await stopServer(server);
    }
    if (cwd) {
      await cleanupTmpDir(cwd);
    }
    cwd = undefined;
    server = undefined;
  });

  test("integrity-checks, caches, and fills only files absent from git", async () => {
    cwd = await makeTmpDir("inrepo-artifact-");
    const archive = tar({
      "package/dist/index.js": "published runtime\n",
      "package/package.json": '{"name":"example"}\n',
      "package/src/index.ts": "published source\n",
    });
    const started = await startArchiveServer(archive);
    ({ server } = started);
    const artifact = {
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      tarballUrl: `http://127.0.0.1:${started.port}/example.tgz`,
    };

    const artifactRoot = await ensurePublishedArtifact(cwd, artifact);
    await stopServer(server);
    server = undefined;
    expect(await ensurePublishedArtifact(cwd, artifact)).toBe(artifactRoot);

    const target = nodePath.join(cwd, "target");
    await mkdir(nodePath.join(target, "src"), { recursive: true });
    await writeFile(nodePath.join(target, "src", "index.ts"), "git source\n");
    await fillMissingPublishedFiles(artifactRoot, target);

    expect(
      await readFile(nodePath.join(target, "src", "index.ts"), "utf-8")
    ).toBe("git source\n");
    expect(
      await readFile(nodePath.join(target, "dist", "index.js"), "utf-8")
    ).toBe("published runtime\n");
    expect(existsSync(nodePath.join(target, ".artifact-meta.json"))).toBe(
      false
    );
  });

  test("rejects bytes that do not match the lock integrity", async () => {
    cwd = await makeTmpDir("inrepo-artifact-integrity-");
    const archive = tar({ "package/index.js": "export default 1;\n" });
    const started = await startArchiveServer(archive);
    ({ server } = started);
    await expect(
      ensurePublishedArtifact(cwd, {
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        tarballUrl: `http://127.0.0.1:${started.port}/bad.tgz`,
      })
    ).rejects.toThrow(/integrity mismatch/u);
  });

  test("rejects tar entries outside the npm package root", async () => {
    cwd = await makeTmpDir("inrepo-artifact-path-");
    const archive = tar({ "../escape.js": "bad\n" });
    const started = await startArchiveServer(archive);
    ({ server } = started);
    await expect(
      ensurePublishedArtifact(cwd, {
        integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
        tarballUrl: `http://127.0.0.1:${started.port}/unsafe.tgz`,
      })
    ).rejects.toThrow(/outside package root/u);
    expect(existsSync(nodePath.join(cwd, "escape.js"))).toBe(false);
  });
});
