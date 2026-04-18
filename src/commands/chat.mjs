import { parseArgs } from "node:util";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolveDeploymentContext } from "../steps/resolve-deployment-context.mjs";
import { log, step, success, dim, spinner } from "../ui.mjs";

export async function chat(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      project: { type: "string" },
      scope: { type: "string" },
      url: { type: "string" },
      "admin-secret": { type: "string" },
      "protection-bypass": { type: "string" },
      "no-ensure": { type: "boolean", default: false },
      "no-refresh": { type: "boolean", default: false },
      "openclaw-spec": { type: "string" },
    },
  });

  log("vclaw chat — attaching to deployed openclaw\n");

  step("Resolving deployment");
  const ctx = await resolveDeploymentContext({
    dir: values.dir,
    url: values.url,
    project: values.project,
    scope: values.scope,
    adminSecret: values["admin-secret"],
    protectionBypassSecret: values["protection-bypass"],
  });
  const appUrl = ctx.url;
  const adminSecret = ctx.adminSecret;
  const bypassSecret = ctx.protectionBypassSecret;
  success(
    `URL ${dim(appUrl)}${bypassSecret ? dim(" + bypass") : ""}`
  );

  if (!values["no-ensure"]) {
    await ensureSandbox(appUrl, adminSecret, bypassSecret);
  }

  if (!values["no-refresh"]) {
    await refreshGatewayToken(appUrl, adminSecret, bypassSecret);
  }

  const handoff = await fetchGatewayHandoff(appUrl, adminSecret, bypassSecret);
  success(
    `Gateway handoff ${dim(`sandbox ${new URL(handoff.sandboxOrigin).host}`)}`
  );

  const wssUrl = `${handoff.sandboxOrigin.replace(/^https?:/, "wss:")}/`;
  const spec = values["openclaw-spec"] ?? "openclaw@latest";
  log(dim(`\nLaunching openclaw TUI (npx -y ${spec} tui)…\n`));

  await spawnTui(spec, wssUrl, handoff.gatewayToken);
}

async function ensureSandbox(appUrl, adminSecret, bypassSecret) {
  const sp = spinner("Waking sandbox");
  try {
    const url = new URL("/api/admin/ensure", appUrl);
    url.searchParams.set("wait", "1");
    if (bypassSecret) {
      url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: buildAuthHeaders(adminSecret, bypassSecret),
    });
    if (!res.ok) {
      const body = await res.text();
      sp.fail(`ensure returned ${res.status}`);
      throw new Error(
        `POST /api/admin/ensure?wait=1 → ${res.status}\n${body.slice(0, 400)}`
      );
    }
    const body = await res.json().catch(() => ({}));
    const label = body?.ready
      ? `Sandbox ready${body.sandboxId ? dim(` (${body.sandboxId})`) : ""}`
      : `Sandbox ${body?.state ?? "scheduled"}${body.sandboxId ? dim(` (${body.sandboxId})`) : ""}`;
    sp.succeed(label);
  } catch (err) {
    if (err?.name !== "Error" || !String(err.message).startsWith("POST /api/admin/ensure")) {
      sp.fail("ensure failed");
    }
    throw err;
  }
}

async function refreshGatewayToken(appUrl, adminSecret, bypassSecret) {
  const sp = spinner("Refreshing AI Gateway token");
  try {
    const url = new URL("/api/admin/refresh-token", appUrl);
    if (bypassSecret) {
      url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: buildAuthHeaders(adminSecret, bypassSecret),
    });
    if (!res.ok) {
      const body = await res.text();
      sp.fail(`refresh-token returned ${res.status}`);
      throw new Error(
        `POST /api/admin/refresh-token → ${res.status}\n${body.slice(0, 400)}`
      );
    }
    const body = await res.json().catch(() => ({}));
    const reason = body?.reason ? ` ${dim(`(${body.reason})`)}` : "";
    sp.succeed(body?.refreshed ? `Token refreshed${reason}` : `Token current${reason}`);
  } catch (err) {
    if (err?.name !== "Error" || !String(err.message).startsWith("POST /api/admin/refresh-token")) {
      sp.fail("refresh-token failed");
    }
    throw err;
  }
}

async function fetchGatewayHandoff(appUrl, adminSecret, bypassSecret) {
  step("Fetching gateway handoff");
  const url = new URL("/gateway/chat", appUrl);
  url.searchParams.set("session", "main");
  if (bypassSecret) {
    url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  }
  const res = await fetch(url, {
    headers: buildAuthHeaders(adminSecret, bypassSecret),
    redirect: "follow",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GET /gateway/chat → ${res.status}\n${body.slice(0, 400)}`
    );
  }
  const html = await res.text();
  return parseGatewayContext(html);
}

export function parseGatewayContext(html) {
  const match = html.match(/var CONTEXT = (\{[\s\S]*?\});/);
  if (!match) {
    throw new Error(
      "Could not locate gateway handoff in /gateway/chat response. The deployed app may be out of date or the sandbox is not yet running."
    );
  }
  let ctx;
  try {
    ctx = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Invalid gateway handoff JSON: ${err.message}`);
  }
  if (!ctx.sandboxOrigin || !ctx.gatewayToken) {
    throw new Error(
      "Gateway handoff missing sandboxOrigin or gatewayToken. The deployed app may be out of date."
    );
  }
  return ctx;
}

function buildAuthHeaders(adminSecret, bypassSecret) {
  const headers = {
    authorization: `Bearer ${adminSecret}`,
    accept: "application/json, text/html",
  };
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return headers;
}

function spawnTui(spec, wssUrl, gatewayToken) {
  return new Promise((resolve, reject) => {
    // Run npx from the OS temp dir so it ignores any project lockfile in the
    // caller's cwd (pnpm-lock.yaml / package-lock.json). Otherwise npm can
    // reject the install with ECOMPROMISED when the lock pins openclaw to an
    // integrity hash different from the current registry entry.
    const child = nodeSpawn(
      "npx",
      ["-y", "--package", spec, "--", "openclaw", "tui", "--url", wssUrl, "--token", gatewayToken],
      { stdio: "inherit", cwd: tmpdir() }
    );
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error("`npx` not found on PATH — install Node.js (includes npm/npx)."));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(new Error(`openclaw tui exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
