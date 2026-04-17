import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import { vercelExec, vercelJson } from "../vercel.mjs";
import { spinner, step, success, warn } from "../ui.mjs";

/**
 * Returns true when either the legacy fixed-name Upstash env vars are present,
 * or the newer marketplace pattern `<PREFIX>_KV_REST_API_URL` /
 * `<PREFIX>_KV_REST_API_TOKEN` is present for at least one prefix.
 */
export function hasUpstashEnvVars(envPayload) {
  return Boolean(findMarketplacePrefix(envPayload));
}

export function findMarketplacePrefix(envPayload, projectNameHint) {
  const envs = Array.isArray(envPayload?.envs) ? envPayload.envs : [];
  const keys = new Set(envs.map((env) => env.key));
  if (
    keys.has("UPSTASH_REDIS_REST_URL") &&
    keys.has("UPSTASH_REDIS_REST_TOKEN")
  ) {
    return { url: "UPSTASH_REDIS_REST_URL", token: "UPSTASH_REDIS_REST_TOKEN" };
  }
  const candidates = [];
  // Legacy marketplace format: <PREFIX>_KV_REST_API_URL / _TOKEN
  for (const key of keys) {
    if (!key.endsWith("_KV_REST_API_URL")) continue;
    const tokenKey = key.replace(/_URL$/, "_TOKEN");
    if (keys.has(tokenKey)) {
      candidates.push({ url: key, token: tokenKey });
    }
  }
  // Current marketplace format (late 2025+): bare KV_REST_API_URL / _TOKEN
  // with no project prefix. Appears when there's exactly one KV integration
  // attached to the project.
  if (keys.has("KV_REST_API_URL") && keys.has("KV_REST_API_TOKEN")) {
    candidates.push({ url: "KV_REST_API_URL", token: "KV_REST_API_TOKEN" });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !projectNameHint) return candidates[0];
  // Multiple marketplace prefixes (rare, but happens when a project has
  // accumulated integrations from prior installs). Prefer the one that
  // matches the current project name so we don't alias to a dead DB.
  const wanted = `${projectNameHint.replace(/-/g, "_").toUpperCase()}_KV_REST_API_URL`;
  const match = candidates.find((c) => c.url === wanted);
  return match || candidates[0];
}

async function readUpstashEnvs(projectDir, scope) {
  return vercelJson(["env", "ls", "--format", "json"], {
    cwd: projectDir,
    scope,
  });
}

export async function waitForUpstashEnvs({
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
      if (hasUpstashEnvVars(payload)) return true;
    } catch {
      // ignore transient failures — the CLI can 404 until the resource
      // finishes attaching
    }
    if (onTick) onTick(attempt);
    await sleep(intervalMs);
  }
  return false;
}

export async function provisionUpstash(projectDir, scope, yes = false) {
  step("Provisioning Upstash Redis via Vercel Marketplace");

  const envPayload = await readUpstashEnvs(projectDir, scope);
  if (hasUpstashEnvVars(envPayload)) {
    success("Upstash Redis already provisioned");
    return;
  }

  warn(
    "This may open a browser for Upstash Terms of Service on first install. Don't close the terminal."
  );

  const result = await vercelExec(["integration", "add", "upstash/upstash-kv"], {
    cwd: projectDir,
    scope,
    nonInteractive: yes,
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  const needsBrowser = /Additional setup required|Opening browser/i.test(combined);

  if (result.code === 0 && !needsBrowser) {
    success("Upstash Redis provisioned and env vars linked");
    return;
  }

  if (!needsBrowser) {
    throw new Error(
      `vercel integration add upstash/upstash-kv exited with code ${result.code}:\n${result.stderr || result.stdout}`
    );
  }

  if (yes) {
    throw new Error(
      "Upstash provisioning needs a browser step. Re-run without --yes."
    );
  }

  const spin = spinner(
    "Waiting for Upstash env vars — finish the browser checkout to continue"
  );

  const ready = await waitForUpstashEnvs({
    read: () => readUpstashEnvs(projectDir, scope),
    onTick: (attempt) => debug(`upstash poll attempt ${attempt}: not ready yet`),
    intervalMs: isReplay() ? 0 : 3000,
  });

  if (!ready) {
    spin.fail("Upstash env vars never appeared");
    throw new Error(
      "Timed out waiting for Upstash KV env vars to appear. " +
        "Confirm the Upstash database was created in the browser, then rerun `vclaw init`."
    );
  }

  spin.succeed("Upstash Redis provisioned and env vars linked");
}
