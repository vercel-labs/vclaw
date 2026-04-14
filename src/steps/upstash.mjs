import { vercelJson, vercelRun } from "../vercel.mjs";
import { step, success, warn } from "../ui.mjs";

export function hasUpstashEnvVars(envPayload) {
  const envs = Array.isArray(envPayload?.envs) ? envPayload.envs : [];
  const keys = new Set(envs.map((env) => env.key));
  return (
    keys.has("UPSTASH_REDIS_REST_URL") &&
    keys.has("UPSTASH_REDIS_REST_TOKEN")
  );
}

export async function provisionUpstash(projectDir, scope, yes = false) {
  step("Provisioning Upstash Redis via Vercel Marketplace");

  const envPayload = await vercelJson(["env", "ls", "--format", "json"], {
    cwd: projectDir,
    scope,
  });
  if (hasUpstashEnvVars(envPayload)) {
    success("Upstash Redis already provisioned");
    return;
  }

  warn(
    "This may open a browser for Upstash Terms of Service on first install. Don't close the terminal."
  );

  try {
    await vercelRun(["integration", "add", "upstash"], {
      cwd: projectDir,
      scope,
      nonInteractive: yes,
    });
  } catch (error) {
    if (yes) {
      throw new Error(
        `${error.message}\nUpstash provisioning can require browser-based terms acceptance. Retry without --yes if this project has not accepted the integration before.`
      );
    }
    throw error;
  }

  success("Upstash Redis provisioned and env vars linked");
}
