import test from "node:test";
import assert from "node:assert/strict";
import {
  _setApiForTesting,
  findAvailableFriendlyProjectName,
  findAvailableProjectName,
} from "./vercel-api.mjs";

test.afterEach(() => {
  _setApiForTesting(null);
});

test("findAvailableProjectName pages names for next numeric suffix after probe window", async () => {
  const existing = new Set([
    "vercel-openclaw",
    ...Array.from({ length: 50 }, (_, index) => "vercel-openclaw-" + (index + 2)),
    "vercel-openclaw-77",
    "vercel-openclaw-scratch",
  ]);
  _setApiForTesting(async (_token, path) => {
    if (path.startsWith("/v9/projects?")) {
      return {
        ok: true,
        status: 200,
        body: {
          projects: [...existing].map((name) => ({ name })),
          pagination: {},
        },
      };
    }
    const prefix = "/v9/projects/";
    assert.ok(path.startsWith(prefix), path);
    const name = decodeURIComponent(path.slice(prefix.length).split("?")[0]);
    if (existing.has(name)) return { ok: true, status: 200, body: { name } };
    return { ok: false, status: 404, body: { error: { code: "not_found" } } };
  });

  const result = await findAvailableProjectName("token", "vercel-openclaw", "team_test", { maxAttempts: 50 });
  assert.deepEqual(result, { name: "vercel-openclaw-78", baseTaken: true });
});


test("findAvailableFriendlyProjectName picks the first free friendly OpenClaw name", async () => {
  const existing = new Set([
    "openclaw-bright-anchor",
    "openclaw-calm-anchor",
  ]);
  _setApiForTesting(async (_token, path) => {
    const prefix = "/v9/projects/";
    assert.ok(path.startsWith(prefix), path);
    const name = decodeURIComponent(path.slice(prefix.length).split("?")[0]);
    if (existing.has(name)) return { ok: true, status: 200, body: { name } };
    return { ok: false, status: 404, body: { error: { code: "not_found" } } };
  });

  const result = await findAvailableFriendlyProjectName("token", "team_test");
  assert.deepEqual(result, { name: "openclaw-clear-anchor", baseTaken: false });
});
