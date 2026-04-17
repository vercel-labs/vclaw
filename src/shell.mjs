import { spawn as nodeSpawn } from "node:child_process";
import { debug } from "./debug.mjs";
import {
  isRecord,
  isReplay,
  normalizeExecKey,
  recordEvent,
  replayEvent,
} from "./tape.mjs";

/**
 * Run a command and return { stdout, stderr, code }.
 * Rejects only on spawn failure, not on non-zero exit.
 */
export function exec(cmd, args = [], opts = {}) {
  const key = normalizeExecKey(`${cmd} ${args.join(" ")}`.trim());
  if (isReplay()) {
    const taped = replayEvent("exec", key);
    debug(`exec ${key} → replayed (code=${taped.code})`);
    return Promise.resolve(taped);
  }
  return new Promise((resolve, reject) => {
    const { input, env, cwd } = opts;
    const startedAt = Date.now();
    debug(`exec ${cmd} ${args.join(" ")}`, cwd ? { cwd } : undefined);
    const child = nodeSpawn(cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error(`Command not found: ${cmd}`));
        return;
      }
      reject(err);
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      const ms = Date.now() - startedAt;
      debug(
        `exec ${cmd} → code=${code ?? 0} (${ms}ms)`,
        {
          stdout: stdout.length > 400 ? `${stdout.slice(0, 400)}…` : stdout,
          stderr: stderr.length > 400 ? `${stderr.slice(0, 400)}…` : stderr,
        }
      );
      const result = {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        code: code ?? 0,
      };
      if (isRecord()) recordEvent("exec", key, result);
      resolve(result);
    });

    if (input === undefined || input === null) {
      child.stdin.end();
      return;
    }

    child.stdin.end(input);
  });
}

/**
 * Run a command, throw if non-zero exit.
 */
export async function run(cmd, args = [], opts = {}) {
  const result = await exec(cmd, args, opts);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout;
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited with code ${result.code}${detail ? `:\n${detail}` : ""}`
    );
  }
  return result.stdout;
}

/**
 * Run a command and stream stdout/stderr to the terminal in real time.
 */
export function spawn(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, {
      stdio: "inherit",
      ...opts,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`\`${cmd} ${args.join(" ")}\` exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
