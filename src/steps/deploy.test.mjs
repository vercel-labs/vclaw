import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDeploymentReadyState,
  pickVerifyTargetForDeployment,
  waitForDeploymentReady,
} from "./deploy.mjs";

test("classifyDeploymentReadyState marks READY as ready", () => {
  assert.deepEqual(classifyDeploymentReadyState({ readyState: "READY" }), {
    ready: true,
    readyState: "READY",
  });
});

test("classifyDeploymentReadyState marks ERROR as terminal-not-ready", () => {
  assert.deepEqual(classifyDeploymentReadyState({ readyState: "ERROR" }), {
    ready: false,
    readyState: "ERROR",
    terminal: true,
  });
});

test("classifyDeploymentReadyState treats CANCELED as terminal-not-ready", () => {
  assert.deepEqual(classifyDeploymentReadyState({ readyState: "CANCELED" }), {
    ready: false,
    readyState: "CANCELED",
    terminal: true,
  });
});

test("classifyDeploymentReadyState marks BUILDING as in-flight", () => {
  assert.deepEqual(classifyDeploymentReadyState({ readyState: "BUILDING" }), {
    ready: false,
    readyState: "BUILDING",
    terminal: false,
  });
});

test("classifyDeploymentReadyState handles missing/empty readyState", () => {
  assert.deepEqual(classifyDeploymentReadyState({}), {
    ready: false,
    readyState: "",
    terminal: false,
  });
});

test("waitForDeploymentReady polls past BUILDING into READY", async () => {
  const states = [{ readyState: "INITIALIZING" }, { readyState: "BUILDING" }, { readyState: "READY" }];
  let attempts = 0;
  const result = await waitForDeploymentReady({
    read: async () => states[attempts++] ?? states[states.length - 1],
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.deployment.readyState, "READY");
});

test("waitForDeploymentReady returns terminal=true on ERROR without spinning until timeout", async () => {
  let calls = 0;
  const result = await waitForDeploymentReady({
    read: async () => {
      calls += 1;
      return { readyState: "ERROR" };
    },
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.terminal, true);
  assert.equal(result.readyState, "ERROR");
  assert.equal(calls, 1);
});

test("waitForDeploymentReady tolerates transient read errors", async () => {
  let calls = 0;
  const result = await waitForDeploymentReady({
    read: async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient 404");
      return { readyState: "READY" };
    },
    timeoutMs: 10_000,
    intervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.ok(calls >= 3);
});

test("waitForDeploymentReady times out when stuck in BUILDING", async () => {
  let currentTime = 0;
  const result = await waitForDeploymentReady({
    read: async () => ({ readyState: "BUILDING" }),
    timeoutMs: 100,
    intervalMs: 10,
    now: () => currentTime,
    sleep: async (ms) => {
      currentTime += ms;
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.terminal, undefined);
});

test("pickVerifyTargetForDeployment prefers project alias when alias is assigned and overlaps", () => {
  const result = pickVerifyTargetForDeployment({
    deployment: {
      aliasAssigned: 1700000000000,
      alias: ["my-app.vercel.app", "vercel-openclaw.example.com"],
    },
    projectAliases: ["my-app.vercel.app", "vercel-openclaw.example.com"],
    preferredAlias: "vercel-openclaw.example.com",
  });
  assert.deepEqual(result, {
    url: "vercel-openclaw.example.com",
    source: "project-alias",
  });
});

test("pickVerifyTargetForDeployment prefers custom domain over .vercel.app when alias assigned", () => {
  const result = pickVerifyTargetForDeployment({
    deployment: {
      aliasAssigned: 1700000000000,
      alias: ["my-app.vercel.app", "custom.example.com"],
    },
    projectAliases: ["my-app.vercel.app", "custom.example.com"],
  });
  assert.deepEqual(result, { url: "custom.example.com", source: "project-alias" });
});

test("pickVerifyTargetForDeployment falls through to deployment alias when project has none", () => {
  const result = pickVerifyTargetForDeployment({
    deployment: {
      aliasAssigned: 1700000000000,
      alias: ["a-1234-team.vercel.app"],
      url: "a-1234-team.vercel.app",
    },
    projectAliases: [],
  });
  assert.deepEqual(result, {
    url: "a-1234-team.vercel.app",
    source: "deployment-alias",
  });
});

test("pickVerifyTargetForDeployment skips project alias when aliasAssigned is falsy (alias has not moved yet)", () => {
  const result = pickVerifyTargetForDeployment({
    deployment: {
      aliasAssigned: null,
      alias: [],
      url: "a-1234-team.vercel.app",
    },
    projectAliases: ["my-app.vercel.app"],
    preferredAlias: "my-app.vercel.app",
  });
  // Without a confirmed alias on the deployment, fall back to the unique URL.
  assert.equal(result.source, "deployment-url");
  assert.equal(result.url, "a-1234-team.vercel.app");
});

test("pickVerifyTargetForDeployment returns null source when nothing is available", () => {
  const result = pickVerifyTargetForDeployment({
    deployment: {},
    projectAliases: [],
  });
  assert.deepEqual(result, { url: null, source: "none" });
});
