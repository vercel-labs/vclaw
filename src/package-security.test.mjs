import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("package manifest has no unreviewed npm dependency surfaces", () => {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    assert.equal(pkg[field], undefined, `${field} must be explicitly security-reviewed before use`);
  }
});

test("package manifest has no consumer install lifecycle hooks", () => {
  const scripts = pkg.scripts ?? {};
  for (const hook of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepack",
    "publish",
    "postpublish",
  ]) {
    assert.equal(scripts[hook], undefined, `${hook} must not run for consumers without review`);
  }

  assert.equal(scripts.preversion, "node scripts/preversion.mjs");
  assert.equal(scripts.postversion, "git push --follow-tags origin HEAD");
});
