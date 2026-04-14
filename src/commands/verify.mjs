import { parseArgs } from "node:util";
import { runVerify } from "../steps/run-verify.mjs";
import { log, success } from "../ui.mjs";

export async function verify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      destructive: { type: "boolean", default: false },
      "admin-secret": { type: "string" },
      "protection-bypass": { type: "string" },
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
  success("Verification complete.");
}
