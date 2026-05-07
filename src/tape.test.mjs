import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubTapeFile, scrubTapeKey, scrubUrl } from "./tape.mjs";

test("scrubUrl redacts sensitive query parameters", () => {
  const url = scrubUrl(
    "https://example.com/gateway/chat?session=main&x-vercel-protection-bypass=bypass-secret-1234567890&token=tok_1234567890abcdef"
  );

  assert.match(url, /session=main/);
  assert.doesNotMatch(url, /bypass-secret/);
  assert.doesNotMatch(url, /tok_1234567890abcdef/);
  assert.match(url, /x-vercel-protection-bypass=\*\*\*SCRUBBED\*\*\*/);
  assert.match(url, /token=\*\*\*SCRUBBED\*\*\*/);
});

test("scrubTapeKey redacts fetch URL secrets while preserving method", () => {
  const key = scrubTapeKey(
    "fetch",
    "POST https://example.com/api/admin/ensure?wait=1&x-vercel-protection-bypass=super-secret-bypass"
  );

  assert.match(key, /^POST https:\/\/example.com\/api\/admin\/ensure/);
  assert.doesNotMatch(key, /super-secret-bypass/);
});

test("scrubTapeFile redacts fetch keys, headers, stderr, and prompt secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "vclaw-tape-test-"));
  const file = join(dir, "tape.json");
  writeFileSync(
    file,
    JSON.stringify({
      events: [
        {
          kind: "fetch",
          key: "GET https://app.vercel.app/gateway/chat?x-vercel-protection-bypass=raw-bypass-secret",
          response: {
            status: 200,
            headers: {
              authorization: "Bearer raw-admin-secret",
              "x-vercel-protection-bypass": "raw-bypass-secret",
            },
            body: JSON.stringify({ token: "raw-body-token", ok: true }),
          },
        },
        {
          kind: "exec",
          key: "npx -y --package openclaw@latest -- openclaw tui --token raw-gateway-token-1234567890",
          response: {
            code: 1,
            stdout: JSON.stringify({ secret: "raw-stdout-secret" }),
            stderr: JSON.stringify({ token: "raw-stderr-token" }),
          },
        },
        {
          kind: "prompt",
          key: "Admin secret",
          response: "raw-prompt-secret",
        },
      ],
    }),
    "utf8"
  );

  scrubTapeFile(file);
  const scrubbed = readFileSync(file, "utf8");

  assert.doesNotMatch(scrubbed, /raw-bypass-secret/);
  assert.doesNotMatch(scrubbed, /raw-admin-secret/);
  assert.doesNotMatch(scrubbed, /raw-body-token/);
  assert.doesNotMatch(scrubbed, /raw-gateway-token/);
  assert.doesNotMatch(scrubbed, /raw-stdout-secret/);
  assert.doesNotMatch(scrubbed, /raw-stderr-token/);
  assert.doesNotMatch(scrubbed, /raw-prompt-secret/);
  assert.match(scrubbed, /\*\*\*SCRUBBED\*\*\*/);
});
