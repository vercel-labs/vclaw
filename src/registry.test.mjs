import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `vclaw-registry-test-${process.pid}`);
const testFile = join(testDir, "registry.json");

let origHome;

beforeEach(() => {
  origHome = process.env.HOME;
  mkdirSync(testDir, { recursive: true });
  // Point the registry at our temp dir by overriding HOME so
  // ~/.vclaw/registry.json resolves inside testDir.
  // We need a subdirectory structure: HOME/.vclaw/registry.json
  const fakeHome = join(testDir, "home");
  mkdirSync(join(fakeHome, ".vclaw"), { recursive: true });
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(testDir, { recursive: true, force: true });
});

// Dynamic import to pick up the HOME override each time
async function loadRegistry() {
  // Clear module cache so homedir() picks up new HOME
  const mod = await import(`./registry.mjs?t=${Date.now()}`);
  return mod;
}

test("readRegistry returns empty object when no file exists", async () => {
  const { readRegistry } = await loadRegistry();
  assert.deepEqual(readRegistry(), {});
});

test("registerClaw creates file and stores entry", async () => {
  const { registerClaw, readRegistry, getClaw } = await loadRegistry();
  registerClaw("my_bot", {
    projectId: "prj_abc",
    orgId: "team_xyz",
    vercelProjectName: "vercel-openclaw",
    scope: "my-team",
  });
  const reg = readRegistry();
  assert.equal(reg.my_bot.projectId, "prj_abc");
  assert.equal(reg.my_bot.orgId, "team_xyz");
  assert.ok(reg.my_bot.createdAt);

  const claw = getClaw("my_bot");
  assert.equal(claw.projectId, "prj_abc");
});

test("registerClaw overwrites existing entry", async () => {
  const { registerClaw, getClaw } = await loadRegistry();
  registerClaw("bot", { projectId: "prj_1", orgId: "team_a" });
  registerClaw("bot", { projectId: "prj_2", orgId: "team_b" });
  const claw = getClaw("bot");
  assert.equal(claw.projectId, "prj_2");
  assert.equal(claw.orgId, "team_b");
});

test("unregisterClaw removes entry and returns true", async () => {
  const { registerClaw, unregisterClaw, getClaw } = await loadRegistry();
  registerClaw("bot", { projectId: "prj_1" });
  const removed = unregisterClaw("bot");
  assert.equal(removed, true);
  assert.equal(getClaw("bot"), null);
});

test("unregisterClaw returns false for missing entry", async () => {
  const { unregisterClaw } = await loadRegistry();
  assert.equal(unregisterClaw("nonexistent"), false);
});

test("listClaws returns sorted array", async () => {
  const { registerClaw, listClaws } = await loadRegistry();
  registerClaw("zeta", { projectId: "z" });
  registerClaw("alpha", { projectId: "a" });
  registerClaw("middle", { projectId: "m" });
  const list = listClaws();
  assert.equal(list.length, 3);
  assert.equal(list[0].name, "alpha");
  assert.equal(list[1].name, "middle");
  assert.equal(list[2].name, "zeta");
});

test("getClaw returns null for missing entry", async () => {
  const { getClaw } = await loadRegistry();
  assert.equal(getClaw("nope"), null);
});

test("validateClawName accepts valid names", async () => {
  const { validateClawName } = await loadRegistry();
  assert.equal(validateClawName("bot"), null);
  assert.equal(validateClawName("my-bot"), null);
  assert.equal(validateClawName("my_bot_2"), null);
  assert.equal(validateClawName("a"), null);
  assert.equal(validateClawName("builder-bot"), null);
});

test("validateClawName rejects invalid names", async () => {
  const { validateClawName } = await loadRegistry();
  assert.match(validateClawName(""), /required/i);
  assert.match(validateClawName("AB"), /lowercase/i);
  assert.match(validateClawName("-bad"), /hyphen/i);
  assert.match(validateClawName("bad-"), /hyphen/i);
  assert.match(validateClawName("has spaces"), /letters, digits/i);
  assert.match(validateClawName("a".repeat(65)), /64 characters/i);
});

test("suggestClawName strips vercel- prefix and cleans", async () => {
  const { suggestClawName } = await loadRegistry();
  assert.equal(suggestClawName("vercel-openclaw"), "openclaw");
  assert.equal(suggestClawName("my-project"), "my-project");
  assert.equal(suggestClawName("vercel-openclaw-2"), "openclaw-2");
  assert.equal(suggestClawName("UPPER-Case"), "upper-case");
});

test("readRegistry handles corrupt JSON gracefully", async () => {
  const { readRegistry, registryPath } = await loadRegistry();
  const path = registryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "not json!", "utf8");
  assert.deepEqual(readRegistry(), {});
});
