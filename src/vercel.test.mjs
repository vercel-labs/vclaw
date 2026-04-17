import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDeploymentUrl,
  getAutomationBypassSecret,
  parseJsonOutput,
  validateProjectName,
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

test("validateProjectName accepts valid names", () => {
  assert.equal(validateProjectName("vercel-openclaw"), null);
  assert.equal(validateProjectName("openclaw-2"), null);
  assert.equal(validateProjectName("a"), null);
  assert.equal(validateProjectName("name_with_underscores"), null);
});

test("validateProjectName rejects invalid names", () => {
  assert.match(validateProjectName(""), /required/i);
  assert.match(validateProjectName("Foo"), /lowercase/i);
  assert.match(validateProjectName("-starts-with-hyphen"), /hyphen/i);
  assert.match(validateProjectName("ends-with-hyphen-"), /hyphen/i);
  assert.match(validateProjectName("has spaces"), /letters, digits/i);
  assert.match(validateProjectName("a".repeat(101)), /100 characters/i);
});
