import { extractDeploymentUrl, vercelRun } from "../vercel.mjs";
import { spinner } from "../ui.mjs";

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
