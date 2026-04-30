import { debug } from "../debug.mjs";
import { isReplay } from "../tape.mjs";
import { extractDeploymentUrl, vercelRun } from "../vercel.mjs";
import { spinner } from "../ui.mjs";

// Terminal `readyState` values from Vercel's deployment API. Anything outside
// these is still in flight ("INITIALIZING" / "BUILDING" / "QUEUED" / etc.).
const TERMINAL_READY_STATES = new Set([
  "READY",
  "ERROR",
  "CANCELED",
]);

export function classifyDeploymentReadyState(deployment) {
  const readyState =
    typeof deployment?.readyState === "string"
      ? deployment.readyState.toUpperCase()
      : "";
  if (readyState === "READY") return { ready: true, readyState };
  if (TERMINAL_READY_STATES.has(readyState)) {
    return { ready: false, readyState, terminal: true };
  }
  return { ready: false, readyState, terminal: false };
}

/**
 * Poll a deployment's `readyState` until it reaches READY (or another
 * terminal state). Mirrors `waitForRedisEnvs` / `waitForManagedEnvVars`:
 * inject `read`/`now`/`sleep` for tests and tape replay.
 *
 * Throws on terminal-but-not-ready states (ERROR, CANCELED) so callers
 * surface the failure instead of silently proceeding to verify.
 */
export async function waitForDeploymentReady({
  read,
  timeoutMs = 5 * 60_000,
  intervalMs = 3_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onTick,
} = {}) {
  const deadline = now() + timeoutMs;
  let attempt = 0;
  let lastDeployment = null;
  while (now() < deadline) {
    attempt += 1;
    try {
      const deployment = await read();
      lastDeployment = deployment;
      const { ready, readyState, terminal } = classifyDeploymentReadyState(deployment);
      if (ready) return { ready: true, attempts: attempt, deployment };
      if (terminal) {
        return {
          ready: false,
          attempts: attempt,
          deployment,
          readyState,
          terminal: true,
        };
      }
      if (onTick) onTick(attempt, readyState);
    } catch (err) {
      // Vercel's deployment endpoint can 404 briefly while the deployment is
      // being registered. Keep polling on transient failures.
      if (onTick) onTick(attempt, `error:${err?.message ?? "unknown"}`);
    }
    await sleep(intervalMs);
  }
  return { ready: false, attempts: attempt, deployment: lastDeployment };
}

/**
 * Pick the alias that corresponds to the just-deployed deployment. Vercel's
 * project response carries `targets.production.alias` (the stable alias
 * list), but a fresh deploy may not yet be wired through it — meaning verify
 * could probe an OLDER deployment that happens to still respond.
 *
 * The deployment record we already fetched is the source of truth: its
 * `aliasAssigned` (epoch ms) flips truthy once routing is wired, and its
 * `alias` array lists the aliases now serving this deployment. Prefer the
 * intersection of the project-level aliases and the deployment's aliases.
 */
export function pickVerifyTargetForDeployment({
  deployment,
  projectAliases = [],
  preferredAlias,
}) {
  const deploymentAliases = Array.isArray(deployment?.alias)
    ? deployment.alias.filter((a) => typeof a === "string")
    : [];
  const overlap = projectAliases.filter((a) => deploymentAliases.includes(a));
  const aliasAssigned = Boolean(deployment?.aliasAssigned);

  if (overlap.length > 0 && aliasAssigned) {
    if (preferredAlias && overlap.includes(preferredAlias)) {
      return { url: preferredAlias, source: "project-alias" };
    }
    const custom = overlap.find((a) => !a.endsWith(".vercel.app"));
    return { url: custom || overlap[0], source: "project-alias" };
  }

  if (preferredAlias && deploymentAliases.includes(preferredAlias)) {
    return { url: preferredAlias, source: "deployment-alias" };
  }
  if (deploymentAliases.length > 0) {
    const custom = deploymentAliases.find((a) => !a.endsWith(".vercel.app"));
    return { url: custom || deploymentAliases[0], source: "deployment-alias" };
  }
  if (typeof deployment?.url === "string" && deployment.url) {
    return { url: deployment.url, source: "deployment-url" };
  }
  return { url: null, source: "none" };
}

const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

function cleanLine(line, cols) {
  const stripped = line.replace(ANSI, "").trim();
  if (!stripped) return "";
  const max = Math.max(20, (cols || 80) - 40);
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

export async function deploy(projectDir, scope, yes = false) {
  const args = ["deploy", "--prod"];
  if (yes) args.push("--yes");

  const spin = spinner("Deploying to Vercel (production) — 0s");
  const start = Date.now();
  let latest = "";

  const render = () => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    const tail = latest ? ` · ${latest}` : "";
    spin.update(`Deploying to Vercel (production) — ${elapsed}s${tail}`);
  };
  const tick = setInterval(render, 500);

  try {
    const result = await vercelRun(args, {
      cwd: projectDir,
      scope,
      onLine: (line) => {
        const cleaned = cleanLine(line, process.stdout.columns);
        if (cleaned) {
          latest = cleaned;
          render();
        }
      },
    });
    const url = extractDeploymentUrl(result.stdout);
    spin.succeed(`Deployed: ${url}`);
    return url;
  } catch (err) {
    spin.fail("Deploy failed");
    throw err;
  } finally {
    clearInterval(tick);
  }
}
