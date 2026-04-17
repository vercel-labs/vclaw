import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import { vercelSpawn } from "../vercel.mjs";
import { listProjectEnvs, readVercelToken } from "../vercel-api.mjs";
import { log, spinner, step, success, warn } from "../ui.mjs";

/**
 * Returns true when a Redis wire-protocol URL is present in the project's
 * environment. Openclaw reads REDIS_URL (primary) and falls back to KV_URL.
 */
export function hasRedisEnvVars(envPayload) {
  return Boolean(findRedisEnvKey(envPayload));
}

export function findRedisEnvKey(envPayload) {
  const envs = Array.isArray(envPayload?.envs) ? envPayload.envs : [];
  const keys = new Set(envs.map((env) => env.key));
  if (keys.has("REDIS_URL")) return "REDIS_URL";
  if (keys.has("KV_URL")) return "KV_URL";
  return null;
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
      if (hasRedisEnvVars(payload)) return true;
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

  const envPayload = await readRedisEnvs(linked);
  if (hasRedisEnvVars(envPayload)) {
    success("Redis already provisioned");
    return;
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
  } catch (err) {
    throw new Error(`vercel integration add redis failed: ${err?.message ?? err}`);
  }

  log("");

  // Code 0 from the CLI is not proof the resource was linked — the user may
  // have answered "n", or the marketplace checkout may still be completing
  // in the browser. Poll the env vars until REDIS_URL / KV_URL shows up.
  const spin = spinner("Verifying REDIS_URL is attached to the project");
  const ready = await waitForRedisEnvs({
    read: () => readRedisEnvs(linked),
    onTick: (attempt) => debug(`redis poll attempt ${attempt}: not ready yet`),
    intervalMs: isReplay() ? 0 : 3000,
  });

  if (!ready) {
    spin.fail("REDIS_URL never appeared");
    throw new Error(
      "Redis was not linked to this project. " +
        "Confirm the resource install in the browser, answer the CLI prompt with Y, then rerun `vclaw create`."
    );
  }

  spin.succeed("Redis provisioned and env vars linked");
}
