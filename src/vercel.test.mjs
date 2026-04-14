import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDeploymentUrl,
  getAutomationBypassSecret,
  parseJsonOutput,
} from "./vercel.mjs";

test("extractDeploymentUrl returns the last URL-like line", () => {
  const url = extractDeploymentUrl("\nInspect: https://example-two.vercel.app\nhttps://example-one.vercel.app\n");
  assert.equal(url, "https://example-one.vercel.app");
});

test("parseJsonOutput parses valid JSON", () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}'), { ok: true });
});

test("getAutomationBypassSecret returns the automation token key", () => {
  const secret = getAutomationBypassSecret({
    "manual-secret": { scope: "shareable-link" },
    "automation-secret": { scope: "automation-bypass" },
  });

  assert.equal(secret, "automation-secret");
});
