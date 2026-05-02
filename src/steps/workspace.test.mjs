import test from "node:test";
import assert from "node:assert/strict";
import { resolveManagedWorkspace, workspaceSegment } from "./workspace.mjs";

test("workspaceSegment makes path-safe slugs", () => {
  assert.equal(workspaceSegment("Vercel Labs!"), "vercel-labs");
  assert.equal(workspaceSegment(""), "default");
});

test("resolveManagedWorkspace places app under owner/project", () => {
  const ws = resolveManagedWorkspace({
    home: "/tmp/vclaw-home",
    scope: "my-team",
    projectName: "My OpenClaw",
  });
  assert.equal(ws.workspaceDir, "/tmp/vclaw-home/my-team/my-openclaw");
  assert.equal(ws.appDir, "/tmp/vclaw-home/my-team/my-openclaw/app");
  assert.equal(ws.metadataPath, "/tmp/vclaw-home/my-team/my-openclaw/vclaw.json");
});

