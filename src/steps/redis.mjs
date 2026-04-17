import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import { vercelExec } from "../vercel.mjs";
import { listProjectEnvs, readVercelToken } from "../vercel-api.mjs";
import { spinner, step, success, warn } from "../ui.mjs";

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

  warn(
    "This may open a browser for Redis Terms of Service on first install. Don't close the terminal."
  );

  const result = await vercelExec(["integration", "add", "redis"], {
    cwd: projectDir,
    scope,
    nonInteractive: yes,
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const needsBrowser = /Additional setup required|Opening browser/i.test(combined);

  if (result.code === 0 && !needsBrowser) {
    success("Redis provisioned and env vars linked");
    return;
  }

  if (!needsBrowser) {
    throw new Error(
      `vercel integration add redis exited with code ${result.code}:\n${result.stderr || result.stdout}`
    );
  }

  if (yes) {
    throw new Error(
      "Redis provisioning needs a browser step. Re-run without --yes."
    );
  }

  const spin = spinner(
    "Waiting for REDIS_URL — finish the browser checkout to continue"
  );

  const ready = await waitForRedisEnvs({
    read: () => readRedisEnvs(linked),
    onTick: (attempt) => debug(`redis poll attempt ${attempt}: not ready yet`),
    intervalMs: isReplay() ? 0 : 3000,
  });

  if (!ready) {
    spin.fail("REDIS_URL never appeared");
    throw new Error(
      "Timed out waiting for REDIS_URL to appear. " +
        "Confirm the Redis database was created in the browser, then rerun `vclaw create`."
    );
  }

  spin.succeed("Redis provisioned and env vars linked");
}
