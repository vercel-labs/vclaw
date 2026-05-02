import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import { parseJsonOutput, vercelExec, vercelSpawn } from "../vercel.mjs";
import { listProjectEnvs, readVercelToken } from "../vercel-api.mjs";
import { log, spinner, step, success, warn } from "../ui.mjs";

/**
 * Returns true when a Redis wire-protocol URL is present in the project's
 * environment. Openclaw reads REDIS_URL (primary) and falls back to KV_URL.
 */
export function hasRedisEnvVars(envPayload) {
  return Boolean(findRedisEnvKey(envPayload));
}

// Marketplace-provisioned env entries appear in the project env list before
// the underlying store is ready. Older Redis installs exposed a placeholder
// value (`database_provisioning_in_progress`) until provisioning finished,
// then rewrote it to a real `redis://` / `rediss://` URL. Newer installs can
// expose REDIS_URL as an integration-store secret instead; the REST API keeps
// the decrypted wire URL hidden, but the runtime resolves it for deployments.
const REDIS_URL_PATTERN = /^rediss?:\/\//i;
const PROVISIONING_PLACEHOLDER_PATTERN = /provision|progress|pending/i;
const INTEGRATION_STORE_SECRET_SETTLE_MS = 60_000;
export const REDIS_RESOURCE_TIMEOUT_MS = 15 * 60_000;

function isIntegrationStoreSecret(entry) {
  return entry?.contentHint?.type === "integration-store-secret";
}

function isSettledIntegrationStoreSecret(entry, now) {
  if (!isIntegrationStoreSecret(entry)) return false;
  const value = typeof entry.value === "string" ? entry.value : "";
  if (!value) return false;

  // Vercel can surface the Redis integration env entry before the backing
  // secret has resolved. Deploying in that window freezes
  // `database_provisioning_in_progress` into the runtime env.
  const timestamp = Number(entry.updatedAt ?? entry.createdAt ?? 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
  return now() - timestamp >= INTEGRATION_STORE_SECRET_SETTLE_MS;
}

export function classifyRedisEntry(entry, { now = () => Date.now() } = {}) {
  if (!entry || typeof entry !== "object") {
    return { resolved: false, reason: "missing" };
  }
  const value = typeof entry.value === "string" ? entry.value : "";
  if (REDIS_URL_PATTERN.test(value)) return { resolved: true, reason: "wire_url" };
  if (PROVISIONING_PLACEHOLDER_PATTERN.test(value)) {
    return { resolved: false, reason: "provisioning_placeholder", value };
  }
  if (isIntegrationStoreSecret(entry)) {
    const timestamp = Number(entry.updatedAt ?? entry.createdAt ?? 0);
    const ageMs = Number.isFinite(timestamp) && timestamp > 0 ? now() - timestamp : null;
    if (isSettledIntegrationStoreSecret(entry, now)) {
      return { resolved: true, reason: "integration_store_secret_settled", ageMs };
    }
    return {
      resolved: false,
      reason: "integration_store_secret_settling",
      ageMs,
      remainingMs: ageMs == null ? null : Math.max(0, INTEGRATION_STORE_SECRET_SETTLE_MS - ageMs),
    };
  }
  return { resolved: false, reason: "unknown_shape", value, contentHint: entry.contentHint?.type };
}

function isResolvedRedisEntry(entry, opts) {
  return classifyRedisEntry(entry, opts).resolved;
}

export function findRedisEnvKey(envPayload, opts = {}) {
  const envs = Array.isArray(envPayload?.envs) ? envPayload.envs : [];
  const byKey = new Map();
  for (const entry of envs) {
    if (entry?.key && !byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  for (const key of ["REDIS_URL", "KV_URL"]) {
    const entry = byKey.get(key);
    if (entry && isResolvedRedisEntry(entry, opts)) return key;
  }
  return null;
}

export function describeRedisCandidates(envPayload, opts = {}) {
  const envs = Array.isArray(envPayload?.envs) ? envPayload.envs : [];
  const byKey = new Map();
  for (const entry of envs) {
    if (entry?.key && !byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  const out = [];
  for (const key of ["REDIS_URL", "KV_URL"]) {
    const entry = byKey.get(key);
    if (!entry) continue;
    out.push({ key, ...classifyRedisEntry(entry, opts) });
  }
  return out;
}

async function readRedisEnvs(linked) {
  const token = readVercelToken();
  if (!token) {
    throw new Error(
      "Could not read Vercel auth token. Run `vercel login` and retry."
    );
  }
  if (!linked?.projectId) {
    throw new Error(
      "Project is not linked yet. Cannot read env vars without a projectId."
    );
  }
  const envs = await listProjectEnvs(token, linked.projectId, linked.teamId);
  return { envs };
}

// Marketplace resource detection via `vercel integration list -F json -i redis`.
// This is what the Vercel CLI itself uses to know whether a resource is
// attached to the current project. Resource-level `status` is the source of
// truth for "Redis is ready"; env entries can lag and have placeholder values
// in the older flat-value flow, so polling envs is a worse signal.
const REDIS_RESOURCE_READY_STATUS = "available";

export function findReadyRedisResource(payload) {
  const resources = Array.isArray(payload?.resources) ? payload.resources : [];
  return (
    resources.find((r) => r?.status === REDIS_RESOURCE_READY_STATUS) ?? null
  );
}

export function findAnyRedisResource(payload) {
  const resources = Array.isArray(payload?.resources) ? payload.resources : [];
  return resources[0] ?? null;
}

export async function listRedisResources({ cwd } = {}) {
  // Run from the linked project dir so the CLI scopes results via the local
  // `.vercel/project.json` (which carries projectId + teamId). Do NOT pass
  // --scope here: vercel CLI 52 rejects `--scope ... integration list -F json
  // -i redis` with "Invalid number of arguments". The cwd-based project link
  // already targets the right team, so --scope is redundant.
  // Stderr carries "Retrieving project…" chatter; stdout is pure JSON.
  const result = await vercelExec(
    ["integration", "list", "-F", "json", "-i", "redis"],
    { cwd }
  );
  if (result.code !== 0) {
    throw new Error(
      `vercel integration list redis exited ${result.code}: ${result.stderr || result.stdout || "<no output>"}`
    );
  }
  return parseJsonOutput(result.stdout, "vercel integration list redis");
}

export async function waitForRedisResource({
  read,
  timeoutMs = REDIS_RESOURCE_TIMEOUT_MS,
  intervalMs = 3000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onTick,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  while (now() < deadline) {
    attempt += 1;
    let observed = null;
    try {
      const payload = await read();
      const ready = findReadyRedisResource(payload);
      if (ready) return ready;
      observed = findAnyRedisResource(payload);
    } catch (err) {
      observed = { error: err instanceof Error ? err.message : String(err) };
    }
    if (onTick) onTick(attempt, observed);
    await sleep(intervalMs);
  }
  return null;
}

export async function waitForRedisEnvs({
  read,
  timeoutMs = 5 * 60_000,
  intervalMs = 3000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onTick,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  while (now() < deadline) {
    attempt += 1;
    try {
      const payload = await read();
      if (findRedisEnvKey(payload, { now })) return true;
    } catch {
      // ignore transient failures — the CLI can 404 until the resource
      // finishes attaching
    }
    if (onTick) onTick(attempt);
    await sleep(intervalMs);
  }
  return false;
}

export async function provisionRedis(projectDir, scope, linked, yes = false) {
  step("Provisioning Redis via Vercel Marketplace");

  // Source of truth: `vercel integration list -F json -i redis` scoped to the
  // current project dir. If a Redis resource is already attached and
  // `available`, skip the marketplace add entirely.
  try {
    const payload = await listRedisResources({ cwd: projectDir });
    const ready = findReadyRedisResource(payload);
    if (ready) {
      success(`Redis already provisioned (${ready.name ?? ready.id ?? "unnamed"})`);
      return;
    }
  } catch (err) {
    debug(`redis pre-check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (yes) {
    throw new Error(
      "Redis provisioning is interactive (CLI 50 prompts `Do you want to link this resource?` " +
        "and opens a browser for Terms of Service). Re-run without --yes."
    );
  }

  warn(
    "The Vercel CLI will prompt you inline (Y/n) and may open a browser for Redis Terms of Service. Answer both to continue."
  );
  log("");

  // Inherit stdio so the user sees and answers the Y/n prompt. Piped stdio
  // causes CLI 50 to silently bail with code 0 without linking anything,
  // which ships a broken deploy (no REDIS_URL → 500 on every route).
  try {
    await vercelSpawn(["integration", "add", "redis"], {
      cwd: projectDir,
      scope,
    });
  } catch {
    // exit code 1 is expected — the CLI opens the browser for TOS and exits
    // before the resource is linked. We poll for the resource below.
  }

  log("");

  // Code 0 from the CLI is not proof the resource was linked — the user may
  // have answered "n", or the marketplace checkout may still be completing
  // in the browser. Poll `vercel integration list` until status="available".
  const spin = spinner("Verifying Redis resource is available");
  const redisPollStartedAt = Date.now();
  const resource = await waitForRedisResource({
    read: () => listRedisResources({ cwd: projectDir }),
    onTick: (attempt, observed) => {
      const elapsed = Math.round((Date.now() - redisPollStartedAt) / 1000);
      if (!observed) {
        spin.update(`Verifying Redis resource is available — ${elapsed}s`);
        debug(`redis poll attempt ${attempt}: no resource attached yet`);
        return;
      }
      if (observed.error) {
        spin.update(`Verifying Redis resource is available — ${elapsed}s`);
        debug(`redis poll attempt ${attempt}: list error: ${observed.error}`);
        return;
      }
      spin.update(
        `Verifying Redis resource is available — ${elapsed}s · ${observed.status ?? "unknown"}`,
      );
      debug(
        `redis poll attempt ${attempt}: ${observed.name ?? observed.id ?? "?"} status=${observed.status ?? "?"}`
      );
    },
    timeoutMs: isReplay() ? 1_000 : REDIS_RESOURCE_TIMEOUT_MS,
    intervalMs: isReplay() ? 0 : 3000,
  });

  if (!resource) {
    spin.fail(
      `Redis resource did not become available within ${formatDuration(REDIS_RESOURCE_TIMEOUT_MS)}`,
    );
    throw new Error(
      "Redis was not linked to this project, or it is still provisioning in Vercel Marketplace. " +
        "Confirm the resource install in the browser, answer the CLI prompt with Y, then rerun `vclaw create`."
    );
  }

  // Sanity check: REDIS_URL/KV_URL env entry should exist now. Do one read
  // (no polling) so a misconfigured resource that's "available" but not
  // attaching env vars surfaces as a clear error rather than a deploy failure.
  try {
    const envPayload = await readRedisEnvs(linked);
    if (!hasRedisEnvVars(envPayload)) {
      debug("redis resource available but REDIS_URL/KV_URL env entry missing");
    }
  } catch (err) {
    debug(`redis env sanity read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  spin.succeed(`Redis provisioned (${resource.name ?? resource.id ?? "unnamed"})`);
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}s`;
  if (remainder === 0) return `${minutes}m`;
  return `${minutes}m ${remainder}s`;
}
