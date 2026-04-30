import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import {
  listProjectEnvs,
  readVercelToken,
  upsertProjectEnv,
} from "../vercel-api.mjs";
import { spinner, step, success, dim } from "../ui.mjs";

const TARGETS = ["production", "preview"];

// Vercel and its marketplace integrations sometimes write placeholder strings
// into env entries while a backing resource is still provisioning (e.g. Redis
// writes `database_provisioning_in_progress` into REDIS_URL until Upstash is
// ready). If we deploy with one of these strings baked in, every request that
// touches that var fails at runtime. This list is the round-trip readback
// denylist for managed env vars we own.
const PLACEHOLDER_VALUES = new Set([
  "database_provisioning_in_progress",
  "provisioning",
  "pending",
  "in_progress",
]);

function isPlaceholderValue(value) {
  if (typeof value !== "string") return false;
  return PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

// Normalize Vercel env entry shapes. The API has used both `target: string[]`
// and `target: string`, and we tolerate mixed-case targets so we don't false-
// fail on a future shape change.
function normalizeTargets(target) {
  const arr = Array.isArray(target)
    ? target
    : typeof target === "string"
      ? [target]
      : [];
  return arr.filter((t) => typeof t === "string").map((t) => t.toLowerCase());
}

// Vercel timestamp fields can be epoch ms (number) or ISO-8601 strings
// depending on which endpoint produced them. Return ms or null for "unknown".
function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// When listProjectEnvs returns multiple entries with the same key (e.g. one
// scoped to "production" and another to "preview"), pick the best entry for
// the requested target. We validate per-target rather than collapsing all
// entries into a synthesized "union" entry — collapsing hides per-target
// divergence (a fresh preview entry can mask a stale production entry, and
// the deploy will then capture stale state).
function pickBestEntryForTarget(entries, target) {
  let best = null;
  let bestTs = -Infinity;
  for (const e of entries) {
    if (!normalizeTargets(e.target).includes(target)) continue;
    const ts =
      parseTimestamp(e.updatedAt) ?? parseTimestamp(e.createdAt) ?? 0;
    if (best === null || ts > bestTs) {
      best = e;
      bestTs = ts;
    }
  }
  return best;
}

// Validate a single env entry against the expected descriptor. Returns null
// when ok or `{ reason }` (unqualified — caller decides whether to qualify
// per-target).
function validateEntryAgainstExpected({
  entry,
  expect,
  startedAt,
  requireFreshTimestampForSensitive,
}) {
  const expectedValue = typeof expect === "string" ? expect : expect?.value;
  const expectedType =
    typeof expect === "string" ? "sensitive" : (expect?.type ?? "sensitive");
  if (typeof entry.type === "string" && entry.type !== expectedType) {
    return { reason: `type-mismatch:${entry.type}` };
  }
  const observedValue = typeof entry.value === "string" ? entry.value : "";
  if (observedValue.length > 0) {
    if (isPlaceholderValue(observedValue)) return { reason: "placeholder" };
    if (expectedType !== "sensitive" && observedValue !== expectedValue) {
      return { reason: "value-mismatch" };
    }
  } else if (expectedType !== "sensitive") {
    return { reason: "missing-value" };
  }
  const tsRaw = entry.updatedAt ?? entry.createdAt;
  const ts = parseTimestamp(tsRaw);
  if (typeof startedAt === "number") {
    if (ts != null && ts < startedAt - 5_000) {
      return { reason: "stale-timestamp" };
    }
    if (
      requireFreshTimestampForSensitive &&
      expectedType === "sensitive" &&
      observedValue.length === 0 &&
      ts == null
    ) {
      return { reason: "sensitive-without-fresh-timestamp" };
    }
  }
  return null;
}

/**
 * Push required env vars to the Vercel project.
 * Returns the admin secret (generated or provided) and a `{[key]: {value, type}}`
 * map ready for `pushEnvVars`.
 *
 * Secrets go in as `sensitive`; per-project identity goes in as `plain` so
 * operators can read them in the Vercel UI and the server can echo them
 * back in Slack manifests / admin surfaces.
 */
export function buildManagedEnvVars({
  adminSecret,
  cronSecret,
  protectionBypassSecret,
  projectScope,
  projectName,
  bundleUrl,
}) {
  const resolvedAdminSecret = adminSecret || randomBytes(32).toString("hex");
  const vars = {
    ADMIN_SECRET: { value: resolvedAdminSecret, type: "sensitive" },
  };

  if (cronSecret) {
    vars.CRON_SECRET = { value: cronSecret, type: "sensitive" };
  }

  if (protectionBypassSecret) {
    vars.VERCEL_AUTOMATION_BYPASS_SECRET = {
      value: protectionBypassSecret,
      type: "sensitive",
    };
  }

  if (projectScope) {
    vars.VCLAW_PROJECT_SCOPE = { value: projectScope, type: "plain" };
  }

  if (projectName) {
    vars.VCLAW_PROJECT_NAME = { value: projectName, type: "plain" };
  }

  if (bundleUrl) {
    vars.OPENCLAW_BUNDLE_URL = { value: bundleUrl, type: "plain" };
    // UI assets tarball — co-located with the bundle by convention.
    // Accept either openclaw.bundle.mjs (ESM, current) or openclaw.bundle.cjs (legacy).
    const uiUrl = bundleUrl.replace(/openclaw\.bundle\.(?:mjs|cjs)$/, "control-ui.tar.gz");
    vars.OPENCLAW_BUNDLE_UI_URL = { value: uiUrl, type: "plain" };
  }

  return {
    adminSecret: resolvedAdminSecret,
    vars,
  };
}

/**
 * Inspect a project env list and report every managed key that is not yet
 * "deploy-ready" — missing, scoped to the wrong target, holding a placeholder,
 * or (for plain values) not matching what we just upserted.
 *
 * Returns an array of `{ key, reason }` issues. Empty array == ready.
 *
 * Sensitive values come back redacted from listProjectEnvs even with
 * `decrypt=true`, so we only verify their presence, target coverage, and
 * (when Vercel exposes it) updatedAt timestamp.
 */
export function findManagedEnvIssues({
  envs,
  expected,
  startedAt,
  targets = TARGETS,
  // When true and an expected key is `sensitive`, require the merged entry
  // to carry a timestamp newer than `startedAt` before declaring it ready.
  // Vercel redacts sensitive values, so without a fresh timestamp we have
  // no way to prove the stored ciphertext matches our upsert; an old
  // sensitive entry with the right key/targets would otherwise pass.
  requireFreshTimestampForSensitive = true,
}) {
  // Group entries by key. We then validate per (key × target) so divergent
  // per-target state (e.g. fresh preview + stale production) is not collapsed
  // into a single passing synthesized entry.
  const grouped = new Map();
  for (const entry of Array.isArray(envs) ? envs : []) {
    if (!entry?.key) continue;
    if (!grouped.has(entry.key)) grouped.set(entry.key, []);
    grouped.get(entry.key).push(entry);
  }

  const normalizedTargets = targets.map((t) => t.toLowerCase());
  const issues = [];
  for (const [key, expect] of Object.entries(expected || {})) {
    const list = grouped.get(key) || [];
    if (list.length === 0) {
      issues.push({ key, reason: "missing" });
      continue;
    }

    // Per-target validation: pick the best (freshest) entry that covers each
    // requested target, then validate independently. perTargetIssues maps
    // target -> { reason } | undefined for ok.
    const perTargetIssues = new Map();
    let coveredAllTargets = true;
    for (const target of normalizedTargets) {
      const entry = pickBestEntryForTarget(list, target);
      if (!entry) {
        perTargetIssues.set(target, { reason: `missing-target:${target}` });
        coveredAllTargets = false;
        continue;
      }
      const issue = validateEntryAgainstExpected({
        entry,
        expect,
        startedAt,
        requireFreshTimestampForSensitive,
      });
      if (issue) perTargetIssues.set(target, issue);
    }

    if (perTargetIssues.size === 0) continue;

    // Dedup: if every target produced the same unqualified reason and the
    // same underlying entry was used (i.e. one entry covers all requested
    // targets), emit a single unqualified issue. Otherwise emit one
    // qualified issue per failing target so the caller can see exactly
    // which target diverged. `missing-target` is already self-qualifying.
    const allTargetsFailed =
      perTargetIssues.size === normalizedTargets.length;
    const reasons = [...perTargetIssues.values()].map((i) => i.reason);
    const allSame = reasons.every((r) => r === reasons[0]);
    if (allTargetsFailed && allSame) {
      const r0 = reasons[0];
      if (r0.startsWith("missing-target:")) {
        // Each entry already carries its own target label.
        for (const issue of perTargetIssues.values()) {
          issues.push({ key, reason: issue.reason });
        }
      } else {
        issues.push({ key, reason: r0 });
      }
    } else {
      // Diverging or partial: qualify each issue with its target so the
      // caller can show which target failed.
      for (const [target, issue] of perTargetIssues) {
        const r = issue.reason.startsWith("missing-target:")
          ? issue.reason
          : `${issue.reason}:${target}`;
        issues.push({ key, reason: r });
      }
    }
    void coveredAllTargets;
  }
  return issues;
}

/**
 * Poll the project env list until every managed var we just upserted
 * round-trips with a valid value. Prevents `vercel deploy` from baking a
 * stale, missing, or placeholder value into the deployment.
 *
 * `read` returns the env list (defaults to a live `listProjectEnvs` call).
 * Tests inject `read`/`now`/`sleep` to avoid hitting the real API, mirroring
 * `waitForRedisEnvs`.
 */
export async function waitForManagedEnvVars({
  read,
  expected,
  startedAt,
  targets = TARGETS,
  timeoutMs = 60_000,
  intervalMs = 2_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onTick,
  requireFreshTimestampForSensitive = true,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  let lastIssues = [{ key: "*", reason: "no-poll-yet" }];
  while (now() < deadline) {
    attempt += 1;
    try {
      const envs = await read();
      const issues = findManagedEnvIssues({
        envs,
        expected,
        startedAt,
        targets,
        requireFreshTimestampForSensitive,
      });
      lastIssues = issues;
      if (issues.length === 0) return { ready: true, attempts: attempt };
    } catch (err) {
      lastIssues = [{ key: "*", reason: `error:${err?.message ?? "unknown"}` }];
    }
    if (onTick) onTick(attempt, lastIssues);
    await sleep(intervalMs);
  }
  return { ready: false, attempts: attempt, issues: lastIssues };
}

export async function pushEnvVars(
  projectDir,
  vars,
  { requireFreshTimestampForSensitive = true } = {},
) {
  step("Configuring environment variables");

  const token = readVercelToken();
  if (!token) {
    throw new Error(
      "Could not find Vercel auth token. Run `vercel login` or set VERCEL_TOKEN."
    );
  }
  const { projectId, teamId } = readLinkedProject(projectDir);

  const entries = Object.entries(vars).map(([key, entry]) => {
    const value = typeof entry === "string" ? entry : entry.value;
    const type = typeof entry === "string" ? "sensitive" : (entry.type ?? "sensitive");
    return { key, value, target: TARGETS, type };
  });

  const startedAt = Date.now();
  await upsertProjectEnv(token, projectId, teamId, entries);

  // Vercel's POST returns 200 before the new env values are guaranteed to be
  // visible to the next build/runtime. Round-trip read until every key we
  // just wrote is back with a non-placeholder value, otherwise the deploy
  // immediately following can capture stale or missing state (the same shape
  // bug as REDIS_URL holding `database_provisioning_in_progress`).
  const spin = spinner("Verifying environment variables are persisted");
  const result = await waitForManagedEnvVars({
    read: () => listProjectEnvs(token, projectId, teamId),
    expected: vars,
    startedAt,
    requireFreshTimestampForSensitive,
    intervalMs: isReplay() ? 0 : 2_000,
    timeoutMs: isReplay() ? 1_000 : 60_000,
    onTick: (attempt, issues) => {
      debug(
        `env readback attempt ${attempt}: ${issues
          .map((i) => `${i.key}=${i.reason}`)
          .join(", ")}`
      );
    },
  });

  let finalResult = result;
  if (!result.ready && requireFreshTimestampForSensitive) {
    // Vercel sometimes omits createdAt/updatedAt on sensitive entries. If
    // that's the ONLY remaining issue across all keys, the strict timestamp
    // gate is what's blocking us — retry once without it. Any other issue
    // (placeholder, value-mismatch, missing-target) keeps blocking.
    const allTimestampOnly =
      Array.isArray(result.issues) &&
      result.issues.length > 0 &&
      result.issues.every(
        (i) => i.reason === "sensitive-without-fresh-timestamp",
      );
    if (allTimestampOnly) {
      debug("env readback retry: sensitive-without-fresh-timestamp only");
      finalResult = await waitForManagedEnvVars({
        read: () => listProjectEnvs(token, projectId, teamId),
        expected: vars,
        startedAt,
        requireFreshTimestampForSensitive: false,
        intervalMs: isReplay() ? 0 : 2_000,
        timeoutMs: isReplay() ? 1_000 : 10_000,
        onTick: (attempt, issues) => {
          debug(
            `env readback retry attempt ${attempt}: ${issues
              .map((i) => `${i.key}=${i.reason}`)
              .join(", ")}`,
          );
        },
      });
    }
  }

  if (!finalResult.ready) {
    spin.fail("Environment variables not yet visible");
    const summary = (finalResult.issues || [])
      .map((i) => `${i.key}: ${i.reason}`)
      .join("; ");
    throw new Error(
      `Vercel did not surface the upserted env vars within ${60}s (${summary}). ` +
        "Re-run `vclaw create` — if this keeps happening, check api.vercel.com for incidents."
    );
  }

  spin.succeed("Environment variables persisted and round-tripped");
  success(
    `Environment variables set ${dim(`(${Object.keys(vars).join(", ")})`)}`
  );
}

export function readLinkedProject(projectDir) {
  const raw = readFileSync(join(projectDir, ".vercel", "project.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.projectId) {
    throw new Error(
      `No projectId in ${projectDir}/.vercel/project.json — linking may have failed.`
    );
  }
  // orgId holds team_xxx for team projects and user_xxx for personal.
  // Vercel's REST API expects teamId only for team-owned projects.
  const teamId =
    typeof parsed.orgId === "string" && parsed.orgId.startsWith("team_")
      ? parsed.orgId
      : undefined;
  return { projectId: parsed.projectId, teamId };
}
