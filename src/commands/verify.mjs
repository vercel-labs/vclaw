import { parseArgs } from "node:util";
import { runVerify } from "../steps/run-verify.mjs";
import { waitForSlackDeliveryReady } from "../steps/provision-slack.mjs";
import { dim, log, success, warn } from "../ui.mjs";

export async function verify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      destructive: { type: "boolean", default: false },
      "admin-secret": { type: "string" },
      "protection-bypass": { type: "string" },
      // Opt-in delivery probe. Today this is a "weak" probe: it reuses the
      // /api/channels/summary signal that powers the post-OAuth wait
      // (configured && connected && deliveryReady). Full end-to-end probe
      // (synthetic signed Slack event_callback → workflow run polling) is
      // tracked in qa/slack-e2e/TODO.md and requires a new admin endpoint
      // in vercel-openclaw.
      "probe-delivery": { type: "boolean", default: false },
      "no-probe-delivery": { type: "boolean", default: false },
      "probe-timeout-ms": { type: "string" },
    },
  });

  if (!values.url) {
    throw new Error("--url is required. Pass the deployment URL to verify.");
  }

  if (!values["admin-secret"]) {
    throw new Error(
      "--admin-secret is required. Pass the admin secret for auth."
    );
  }

  log(`vclaw verify — checking ${values.url}\n`);
  await runVerify(values.url, values["admin-secret"], {
    destructive: values.destructive,
    protectionBypassSecret:
      values["protection-bypass"] ||
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  });

  // Optional Slack delivery readiness probe.
  const probeRequested = values["probe-delivery"] && !values["no-probe-delivery"];
  if (probeRequested) {
    const timeoutMs = values["probe-timeout-ms"]
      ? Math.max(1000, Number.parseInt(values["probe-timeout-ms"], 10))
      : 60_000;
    log(dim("\nProbing Slack delivery readiness via /api/channels/summary…"));
    const readiness = await waitForSlackDeliveryReady(
      values.url,
      values["admin-secret"],
      {
        protectionBypassSecret:
          values["protection-bypass"] ||
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        timeoutMs,
      }
    );
    if (!readiness.deliveryReady) {
      warn(
        "Slack delivery is NOT ready. " +
          (readiness.configured && readiness.connected
            ? "Credentials are saved and auth.test passed, but the gateway never flipped " +
              "routeReady/liveConfigFresh. If a real Slack message hangs on \"Verifying config…\" " +
              ">2 min, run `vclaw doctor --url <deployment>` for sandbox state introspection, " +
              "and check `vercel logs <deployment>` for stale-lock or warm-restore errors."
            : "Slack credentials may not be configured for this deployment.")
      );
      throw new Error(
        `Slack delivery probe failed (configured=${readiness.configured}, connected=${readiness.connected}, deliveryReady=${readiness.deliveryReady}).`
      );
    }
    log(dim("Slack delivery probe: ready."));
  }

  success("Verification complete.");
}
