import test from "node:test";
import assert from "node:assert/strict";
import { formatVercelAuthError } from "./prereqs.mjs";

test("formatVercelAuthError gives action-first message for expired CLI login", () => {
  const message = formatVercelAuthError({
    source: "cli",
    path: "/Users/me/.local/share/com.vercel.cli/auth.json",
    detail:
      'GET /v2/user failed (403): {"error":{"code":"forbidden","message":"Not authorized","invalidToken":true}}',
  });
  assert.match(message, /^Your Vercel CLI login has expired or is invalid\./);
  assert.match(message, /Auth file:\n  \/Users\/me\/\.local\/share\/com\.vercel\.cli\/auth\.json/);
  assert.match(message, /Vercel response: 403 - forbidden - Not authorized - invalidToken/);
  assert.match(message, /Run `vercel login`, then rerun `vclaw create`\.$/);
});

test("formatVercelAuthError explains VERCEL_TOKEN separately", () => {
  const message = formatVercelAuthError({ source: "env", detail: "invalidToken" });
  assert.match(message, /^VERCEL_TOKEN is set, but Vercel rejected it\./);
  assert.match(message, /Unset VERCEL_TOKEN or replace it/);
  assert.match(message, /Vercel response: invalidToken/);
});

test("formatVercelAuthError gives login command when no token exists", () => {
  assert.equal(
    formatVercelAuthError({ source: "none" }),
    "You are not logged in to Vercel. Run `vercel login`, then rerun `vclaw create`.",
  );
});
