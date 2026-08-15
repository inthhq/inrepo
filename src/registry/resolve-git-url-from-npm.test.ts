import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isString } from "../json/unknown.js";
import {
  resolveGitUrlFromNpm,
  resolvePackageSourceFromNpm,
} from "./resolve-git-url-from-npm.js";

const mockFetchOnce = function mockFetchOnce(
  responses: { status?: number; body: unknown }[]
) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  let i = 0;
  const fetchImpl = Object.assign(
    (input: string | URL | Request, _init?: RequestInit) => {
      let url: string;
      if (isString(input)) {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        ({ url } = input);
      }
      calls.push(url);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      const status = r.status ?? 200;
      return Promise.resolve(
        Response.json(r.body ?? null, {
          headers: { "content-type": "application/json" },
          status,
        })
      );
    },
    { preconnect: original.preconnect }
  );
  globalThis.fetch = fetchImpl;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

describe("resolveGitUrlFromNpm", () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    restore = null;
  });

  afterEach(() => {
    restore?.();
  });

  test("returns normalized https URL from a string repository", async () => {
    const m = mockFetchOnce([
      {
        body: { repository: "git+https://github.com/foo/bar.git" },
      },
    ]);
    ({ restore } = m);
    const url = await resolveGitUrlFromNpm("bar");
    expect(url).toBe("https://github.com/foo/bar.git");
    expect(m.calls[0]).toBe("https://registry.npmjs.org/bar");
  });

  test("returns normalized URL from an object repository", async () => {
    const m = mockFetchOnce([
      {
        body: {
          repository: { type: "git", url: "https://github.com/foo/bar" },
        },
      },
    ]);
    ({ restore } = m);
    expect(await resolveGitUrlFromNpm("bar")).toBe(
      "https://github.com/foo/bar.git"
    );
  });

  test("returns a normalized package directory with the repository source", async () => {
    const m = mockFetchOnce([
      {
        body: {
          repository: {
            directory: "./packages/cli/",
            type: "git",
            url: "https://github.com/c15t/c15t",
          },
        },
      },
    ]);
    ({ restore } = m);
    expect(await resolvePackageSourceFromNpm("@c15t/cli")).toEqual({
      gitUrl: "https://github.com/c15t/c15t.git",
      repositoryDirectory: "packages/cli",
    });
  });

  test("falls back to dist-tags.latest version repository", async () => {
    const m = mockFetchOnce([
      {
        body: {
          "dist-tags": { latest: "1.2.3" },
          versions: { "1.2.3": { repository: "git@github.com:foo/bar.git" } },
        },
      },
    ]);
    ({ restore } = m);
    expect(await resolveGitUrlFromNpm("bar")).toBe(
      "https://github.com/foo/bar.git"
    );
  });

  test("encodes scoped names in the URL", async () => {
    const m = mockFetchOnce([
      { body: { repository: "https://github.com/clack/clack" } },
    ]);
    ({ restore } = m);
    await resolveGitUrlFromNpm("@clack/prompts");
    expect(m.calls[0]).toBe("https://registry.npmjs.org/%40clack%2Fprompts");
  });

  test("throws on 404 with the package name in the message", async () => {
    const m = mockFetchOnce([{ body: { error: "Not found" }, status: 404 }]);
    ({ restore } = m);
    await expect(resolveGitUrlFromNpm("does-not-exist")).rejects.toThrow(
      /package not found: does-not-exist/u
    );
  });

  test("throws on other HTTP errors", async () => {
    const m = mockFetchOnce([{ body: "oops", status: 500 }]);
    ({ restore } = m);
    await expect(resolveGitUrlFromNpm("bar")).rejects.toThrow(
      /HTTP 500 for bar/u
    );
  });

  test("throws when there is no repository field anywhere", async () => {
    const m = mockFetchOnce([
      { body: { "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } } },
    ]);
    ({ restore } = m);
    await expect(resolveGitUrlFromNpm("bar")).rejects.toThrow(
      /No "repository" field for "bar"/u
    );
  });

  test("throws when repository URL cannot be normalized to GitHub", async () => {
    const m = mockFetchOnce([
      { body: { repository: "https://gitlab.com/foo/bar.git" } },
    ]);
    ({ restore } = m);
    await expect(resolveGitUrlFromNpm("bar")).rejects.toThrow(
      /Could not normalize repository URL/u
    );
  });
});
