import { describe, expect, test } from "bun:test";

import { redactCredentials } from "./run-mirror.js";

describe("redactCredentials", () => {
  test("hides user and token in URLs, including @ inside userinfo", () => {
    expect(
      redactCredentials(
        "git push https://alice@corp.com:sekrit@github.com/acme/sdk.git failed"
      )
    ).toBe("git push https://***@github.com/acme/sdk.git failed");
    expect(redactCredentials("https://x-access-token:ghp_1@github.com/a")).toBe(
      "https://***@github.com/a"
    );
  });

  test("leaves URLs without credentials and scp-style targets alone", () => {
    const text = "https://github.com/acme/sdk.git and git@github.com:acme/sdk";
    expect(redactCredentials(text)).toBe(text);
  });
});
