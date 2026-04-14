import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthHeaders } from "./run-verify.mjs";

test("buildAuthHeaders includes the admin bearer token", () => {
  assert.deepEqual(buildAuthHeaders("admin-secret"), {
    Authorization: "Bearer admin-secret",
  });
});

test("buildAuthHeaders includes deployment protection bypass when provided", () => {
  assert.deepEqual(buildAuthHeaders("admin-secret", "bypass-secret"), {
    Authorization: "Bearer admin-secret",
    "x-vercel-protection-bypass": "bypass-secret",
  });
});
