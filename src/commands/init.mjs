import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkPrereqs } from "../steps/prereqs.mjs";
import { cloneRepo } from "../steps/clone.mjs";
import { linkProject } from "../steps/link.mjs";
import { provisionUpstash } from "../steps/upstash.mjs";
import { buildManagedEnvVars, pushEnvVars, readLinkedProject } from "../steps/env.mjs";
import { deploy } from "../steps/deploy.mjs";
import { runVerify } from "../steps/run-verify.mjs";
import {
  configureProjectProtection,
  resolveProtectionPlan,
} from "../steps/protection.mjs";
import {
  findAvailableName,
  validateProjectName,
} from "../vercel.mjs";
import {
  ensureAutomationBypassSecret,
  getProductionAlias,
  getProject,
  getTeamBySlug,
  getUser,
  listProjects,
  listTeams,
  readProtectionState,
  readVercelToken,
  setActiveTeam,
} from "../vercel-api.mjs";
import { isInteractive, log, prompt, step, success, warn } from "../ui.mjs";

const DEFAULT_NAME = "vercel-openclaw";
const DEFAULT_DIR = "./vercel-openclaw";

async function resolveScope(canPrompt) {
  step("Checking Vercel team scopes");

  const token = readVercelToken();
  const user = token ? await getUser(token).catch(() => null) : null;
  const isNorthstar = user?.version === "northstar";
  const defaultTeamId = user?.defaultTeamId;

  let teams = [];
  if (token) {
    try {
      teams = await listTeams(token);
    } catch {
      // treat as single-scope
    }
  }

  // Northstar users don't have a standalone personal scope — their default
  // team IS their personal context per the Vercel CLI (see get-scope.ts).
  // Skip the "personal" option for them; everything else routes to a team.
  const personalSlug = user?.username;
  if (teams.length === 0) {
    return {
      scope: undefined,
      activeSlug: personalSlug,
      isPersonal: !isNorthstar,
      teamId: isNorthstar ? defaultTeamId : undefined,
    };
  }

  const choices = [];
  if (personalSlug && !isNorthstar) {
    choices.push({
      slug: personalSlug,
      label: `${personalSlug} (personal)`,
      isPersonal: true,
      teamId: undefined,
    });
  }
  for (const team of teams) {
    const suffix = team.id === defaultTeamId ? " — default" : "";
    choices.push({
      slug: team.slug,
      label: `${team.name} (${team.slug})${suffix}`,
      isPersonal: false,
      teamId: team.id,
    });
  }

  if (!canPrompt) {
    const fallback = choices[0];
    return {
      scope: fallback.isPersonal ? undefined : fallback.slug,
      activeSlug: fallback.slug,
      isPersonal: fallback.isPersonal,
      teamId: fallback.teamId,
    };
  }

  log("");
  choices.forEach((choice, i) => {
    log(`  ${i + 1}) ${choice.label}`);
  });
  log("");

  const defaultIndex = "1";
  const answer = await prompt(
    `Which scope should own the project? [1-${choices.length}]`,
    defaultIndex
  );
  const idx = Number.parseInt(answer, 10);
  const picked =
    Number.isFinite(idx) && idx >= 1 && idx <= choices.length
      ? choices[idx - 1]
      : (warn(`Invalid selection "${answer}" — using ${choices[0].label}.`),
        choices[0]);

  return {
    scope: picked.isPersonal ? undefined : picked.slug,
    activeSlug: picked.slug,
    isPersonal: picked.isPersonal,
    teamId: picked.teamId,
  };
}

function findAvailableDir(base) {
  const target = resolve(base);
  if (!existsSync(target)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existsSync(resolve(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function init(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      scope: { type: "string" },
      team: { type: "string" },
      dir: { type: "string" },
      "admin-secret": { type: "string" },
      "cron-secret": { type: "string" },
      "deployment-protection": { type: "string", default: "none" },
      "protection-bypass-secret": { type: "string" },
      "skip-deploy": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });

  if (values.team && values.scope && values.team !== values.scope) {
    throw new Error("Pass only one of --scope or deprecated --team.");
  }

  let scope = values.scope || values.team;
  if (values.team) {
    warn("`--team` is deprecated. Use `--scope`.");
  }

  const protectionPlan = resolveProtectionPlan(
    values["deployment-protection"],
    values["protection-bypass-secret"]
  );

  log("vclaw init — setting up vercel-openclaw\n");

  // 1. Check local prereqs
  await checkPrereqs();

  const canPrompt = isInteractive() && !values.yes;

  // 2. Resolve Vercel scope (prompt when user has multiple teams)
  let activeSlug = scope;
  let pickedPersonal = !scope;
  let pickedTeamId;
  if (!scope) {
    const resolved = await resolveScope(canPrompt);
    scope = resolved.scope;
    activeSlug = resolved.activeSlug;
    pickedPersonal = resolved.isPersonal;
    pickedTeamId = resolved.teamId;
  } else {
    // An explicit --scope still needs its teamId resolved so we can align the
    // CLI's active team for browser-based flows (marketplace checkout, etc).
    const token = readVercelToken();
    if (token) {
      try {
        const team = await getTeamBySlug(token, scope);
        if (team?.id) {
          pickedTeamId = team.id;
          pickedPersonal = false;
        } else {
          const user = await getUser(token).catch(() => null);
          if (user && user.username === scope) {
            pickedPersonal = user.version !== "northstar";
            pickedTeamId = user.version === "northstar" ? user.defaultTeamId : undefined;
          }
        }
      } catch {
        // fall through — linkProject will surface a clear error if the scope is invalid
      }
    }
  }

  // Align the CLI's active team (config.json `currentTeam`) with the chosen
  // selection so browser-based flows (e.g. `integration add` marketplace
  // checkout) open against the correct team. `--scope` alone isn't honored
  // by those URL-based flows. For Northstar users there is no real personal
  // scope — we always route to a team id.
  try {
    if (pickedPersonal) {
      if (setActiveTeam(null)) {
        success("Active Vercel team cleared (personal scope)");
      }
    } else if (pickedTeamId) {
      if (setActiveTeam(pickedTeamId)) {
        success(`Active Vercel team set to "${activeSlug}"`);
      } else {
        warn(
          `Could not set Vercel active team to "${activeSlug}". Browser flows may open against your previously active team.`
        );
      }
    }
  } catch (err) {
    warn(`Could not update Vercel active team: ${err.message}`);
  }

  // 3. Resolve clone directory (prompt with smart default)
  let dir = values.dir;
  if (!dir) {
    const suggested = findAvailableDir(DEFAULT_DIR);
    dir = canPrompt
      ? await prompt("Clone vercel-openclaw into which directory?", suggested)
      : suggested;
  }

  // 4. Resolve Vercel project name (prompt if default is taken)
  let name = values.name;
  if (name) {
    const nameError = validateProjectName(name);
    if (nameError) {
      throw new Error(`--name "${name}" is invalid: ${nameError}`);
    }
  } else {
    let suggested = DEFAULT_NAME;
    try {
      const token = readVercelToken();
      // Query the actual target team so we don't suggest a name that already
      // exists in that team (which would silently reuse a stale project with
      // inherited env vars). Falls back to the token's default scope if we
      // don't have a teamId yet.
      const taken = token
        ? await listProjects(token, { teamId: pickedTeamId })
        : new Set();
      suggested = findAvailableName(DEFAULT_NAME, taken);
      if (taken && taken.has(DEFAULT_NAME) && canPrompt) {
        warn(
          `A Vercel project named "${DEFAULT_NAME}" already exists in ${activeSlug || "this scope"} — suggesting "${suggested}".`
        );
      }
    } catch {
      // ignore — fall back to default and let prompts/link surface issues
    }
    if (canPrompt) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = await prompt("Vercel project name?", suggested);
        const err = validateProjectName(answer);
        if (!err) {
          name = answer;
          break;
        }
        warn(err);
      }
      if (!name) {
        throw new Error(
          "Could not get a valid Vercel project name after 3 attempts."
        );
      }
    } else {
      name = suggested;
    }
  }

  // 5. Clone
  const projectDir = await cloneRepo(dir);

  // 6. Link to Vercel
  const linked = await linkProject(projectDir, name, scope);

  // 7. Provision Upstash Redis
  await provisionUpstash(projectDir, scope, values.yes);

  // 8. Configure project protection when requested
  let { protectionBypassSecret } = await configureProjectProtection(
    projectDir,
    name,
    scope,
    protectionPlan
  );

  // 8a. Auto-detect pre-existing protection on the project (most common when
  // reusing an existing project) and ensure we have an automation bypass
  // secret so launch-verify can hit the admin routes. Without this, a user
  // who linked to a protection-enabled project without passing
  // --protection-bypass-secret would silently get 401/403 at verify time.
  if (!protectionBypassSecret) {
    try {
      const token = readVercelToken();
      if (token && linked?.projectId) {
        const project = await getProject(token, linked.projectId, linked.teamId);
        const state = readProtectionState(project);
        if (state.enabled) {
          warn(
            `Deployment protection detected (${state.activeTypes.join(", ")}) — ` +
              `generating an automation bypass secret so verify can reach /api/admin.`
          );
          const { secret, created } = await ensureAutomationBypassSecret(
            token,
            linked.projectId,
            linked.teamId,
            { note: "vclaw init auto-detected protection" }
          );
          protectionBypassSecret = secret;
          success(
            created
              ? "Automation bypass secret created"
              : "Reusing existing automation bypass secret"
          );
        }
      }
    } catch (err) {
      warn(`Could not auto-resolve protection bypass: ${err.message}`);
    }
  }

  // 9. Resolve admin secret (prompt with a generated default)
  let resolvedAdminSecret = values["admin-secret"];
  if (!resolvedAdminSecret) {
    const generated = randomBytes(32).toString("hex");
    resolvedAdminSecret = canPrompt
      ? await prompt(
          "ADMIN_SECRET (press Enter to use the generated one)",
          generated
        )
      : generated;
  }

  // 10. Generate and push env vars
  const { adminSecret, vars } = buildManagedEnvVars({
    adminSecret: resolvedAdminSecret,
    cronSecret: values["cron-secret"],
    protectionBypassSecret,
  });
  await pushEnvVars(projectDir, vars, scope);

  if (values["skip-deploy"]) {
    warn("Skipping deploy (--skip-deploy). Run `vclaw verify` after deploying.");
    return;
  }

  // 11. Deploy
  const deployUrl = await deploy(projectDir, scope, values.yes);

  // Unique deployment URLs (*-hash-team.vercel.app) are gated by Vercel's
  // Standard Protection SSO even when the project-level toggle is "off",
  // which makes /api/admin/preflight return HTML 401 from the edge. The
  // canonical production alias (<project>.vercel.app or a custom domain)
  // skips that gate. Prefer it when available.
  let verifyUrl = deployUrl;
  try {
    const token = readVercelToken();
    if (token) {
      const { projectId, teamId } = readLinkedProject(projectDir);
      const alias = await getProductionAlias(token, projectId, teamId);
      if (alias) verifyUrl = alias;
      else warn(
        `No production alias found — verifying against the unique deployment URL. ` +
          `If the project has Standard Protection enabled, verify may return 401.`
      );
    }
  } catch (err) {
    warn(`Could not resolve production alias: ${err.message}`);
  }

  // 12. Verify
  await runVerify(verifyUrl, adminSecret, { protectionBypassSecret });

  success(`\nDone! Your OpenClaw instance is live at ${verifyUrl}`);
  log(`Admin secret: ${adminSecret}`);
  if (protectionBypassSecret) {
    log(`Protection bypass secret: ${protectionBypassSecret}`);
  }
  log("Save this secret — it won't be shown again.\n");
  log("Next steps:");
  log("  • Open the admin UI at the URL above");
  log("  • Connect Slack/Telegram channels from the admin panel");
  if (!protectionBypassSecret) {
    log("  • If you later enable Vercel Deployment Protection, also set VERCEL_AUTOMATION_BYPASS_SECRET");
  }
  log("  • See https://github.com/vercel-labs/vercel-openclaw for docs");

  openInBrowser(verifyUrl);
}

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort — user can always click the URL
  }
}
