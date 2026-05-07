import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { debug } from "./debug.mjs";

/**
 * Record/replay layer for the three external I/O points vclaw touches:
 *   - shell exec (git, vercel CLI)
 *   - HTTP fetch (api.vercel.com + the deployed app's /api/admin/*)
 *   - interactive prompts (readline)
 *
 * Usage:
 *   VCLAW_RECORD=.vclaw-tape.json  npx vclaw create  # capture a tape
 *   VCLAW_REPLAY=.vclaw-tape.json  npx vclaw create  # replay without touching anything real
 *
 * Matching is strict-ordered across all kinds: the Nth taped event must match
 * the Nth call. If the code path changes, re-record.
 *
 * Tapes contain decrypted env var values and auth tokens — treat them as
 * local-only. They're in .gitignore.
 */

const RECORD_PATH = process.env.VCLAW_RECORD || null;
const REPLAY_PATH = process.env.VCLAW_REPLAY || null;

if (RECORD_PATH && REPLAY_PATH) {
  throw new Error("Set VCLAW_RECORD or VCLAW_REPLAY — not both.");
}

const MODE = RECORD_PATH ? "record" : REPLAY_PATH ? "replay" : "off";

let events = [];
let cursor = 0;

if (MODE === "replay") {
  try {
    const raw = readFileSync(REPLAY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    events = Array.isArray(parsed.events) ? parsed.events : [];
    debug(`tape: loaded ${events.length} events from ${REPLAY_PATH}`);
  } catch (err) {
    throw new Error(`Could not load replay tape at ${REPLAY_PATH}: ${err.message}`);
  }
}

function flush() {
  if (MODE !== "record") return;
  const sanitized = events.map(scrubEvent);
  writeFileSync(
    RECORD_PATH,
    `${JSON.stringify({ events: sanitized }, null, 2)}\n`,
    "utf8"
  );
  debug(`tape: flushed ${sanitized.length} events to ${RECORD_PATH} (scrubbed)`);
}

// Keys whose values we always strip — covers decrypted env values, user emails,
// auth tokens, and billing blobs. Walks the tree recursively.
const SCRUB_KEYS = new Set([
  "value",
  "email",
  "secondaryEmails",
  "billing",
  "avatar",
  "token",
  "secret",
  "apiKey",
  "username",
  "stagingPrefix",
  "defaultTeamId",
]);

const EMAILLIKE_KEY = /email/i;
// Catches compound keys like `gitHubAuthToken`, `inviteCode`, `createdByUser`,
// etc. without listing every one.
const SENSITIVE_KEY = /(token|secret|password|apikey|credential|session|bearer|cookie)/i;
const SENSITIVE_QUERY_PARAM = /(token|secret|password|apikey|credential|bearer|cookie|x-vercel-protection-bypass)/i;
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|x-vercel-protection-bypass)$/i;
const SECRETLIKE_VALUE = /(bearer\s+)?[A-Za-z0-9._~+/-]{20,}={0,2}/g;

function scrubJsonValue(node, parentKey) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((v) => scrubJsonValue(v, parentKey));
  if (typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SCRUB_KEYS.has(k) || EMAILLIKE_KEY.test(k) || SENSITIVE_KEY.test(k)) {
        out[k] = "***SCRUBBED***";
      } else {
        out[k] = scrubJsonValue(v, k);
      }
    }
    return out;
  }
  if (typeof node === "string" && parentKey === "name") {
    // User/team display names — identify the human. Not strictly a secret,
    // but cheap to redact. Slugs and project names stay untouched.
    return "***SCRUBBED***";
  }
  return node;
}

function scrubBody(raw) {
  if (typeof raw !== "string" || !raw) return raw;
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(scrubJsonValue(parsed));
  } catch {
    return raw;
  }
}

function scrubText(raw) {
  if (typeof raw !== "string" || !raw) return raw;
  return raw.replace(SECRETLIKE_VALUE, "***SCRUBBED***");
}

export function scrubUrl(raw) {
  if (typeof raw !== "string" || !raw) return raw;
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM.test(key)) {
        parsed.searchParams.set(key, "***SCRUBBED***");
      }
    }
    return parsed.toString();
  } catch {
    return raw.replace(
      /([?&][^=&#]*(?:token|secret|password|apikey|credential|session|bearer|cookie|x-vercel-protection-bypass)[^=&#]*=)([^&#]*)/gi,
      "$1***SCRUBBED***"
    );
  }
}

export function scrubTapeKey(kind, key) {
  if (typeof key !== "string") return key;
  if (kind === "fetch") {
    const match = key.match(/^(\S+)\s+(.+)$/);
    if (match) return `${match[1]} ${scrubUrl(match[2])}`;
    return scrubUrl(key);
  }
  if (kind === "exec") return scrubText(key);
  return key;
}

function scrubHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER.test(key) || SENSITIVE_KEY.test(key)
      ? "***SCRUBBED***"
      : scrubText(value);
  }
  return out;
}

function scrubEvent(event) {
  const base = {
    ...event,
    key: scrubTapeKey(event.kind, event.key),
  };
  if (event.kind === "fetch" && event.response) {
    return {
      ...base,
      response: {
        ...event.response,
        headers: scrubHeaders(event.response.headers),
        body: scrubBody(event.response.body),
      },
    };
  }
  if (event.kind === "exec" && event.response) {
    return {
      ...base,
      response: {
        ...event.response,
        stdout: scrubBody(event.response.stdout),
        stderr: scrubBody(event.response.stderr),
      },
    };
  }
  if (event.kind === "prompt") {
    // Prompt answers often hold admin secrets and project names. Keep the key
    // (the question) but scrub the response — replay still advances the cursor.
    const question = event.key || "";
    const looksSensitive = /secret|token|password/i.test(question);
    return looksSensitive
      ? { ...base, response: "***SCRUBBED***" }
      : base;
  }
  return base;
}

export function scrubTapeFile(path) {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  const scrubbed = {
    events: (parsed.events || []).map(scrubEvent),
  };
  writeFileSync(path, `${JSON.stringify(scrubbed, null, 2)}\n`, "utf8");
  return scrubbed.events.length;
}

if (MODE === "record") {
  process.on("exit", flush);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      flush();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * Normalize cwd-specific paths inside an exec key so a tape recorded from
 * one working directory replays cleanly from another. We substitute the
 * current cwd with <CWD> and $HOME with <HOME>; both sides of the record
 * vs. replay comparison run through this.
 */
export function normalizeExecKey(key) {
  if (typeof key !== "string") return key;
  const cwd = process.cwd();
  const home = homedir();
  let out = key;
  if (cwd && out.includes(cwd)) out = out.split(cwd).join("<CWD>");
  if (home && out.includes(home)) out = out.split(home).join("<HOME>");
  // /private/tmp/... on macOS resolves to /tmp/... under some invocations;
  // collapse that too so replay under `cd /tmp/foo` matches a record under
  // `cd /private/tmp/foo`.
  out = out.replace(/\/private\/(tmp|var)\b/g, "/$1");
  return out;
}

export function mode() {
  return MODE;
}

export function isReplay() {
  return MODE === "replay";
}

export function isRecord() {
  return MODE === "record";
}

export function recordEvent(kind, key, response) {
  if (MODE !== "record") return;
  events.push({ kind, key, response });
}

export function replayEvent(kind, key) {
  if (MODE !== "replay") return null;
  const next = events[cursor];
  if (!next) {
    throw new Error(
      `tape: ran off the end at event ${cursor}. Expected ${kind} "${key}" but tape has ${events.length} events. Re-record.`
    );
  }
  if (next.kind !== kind) {
    throw new Error(
      `tape: event ${cursor} kind mismatch. Tape has ${next.kind} "${next.key}"; code asked for ${kind} "${key}". Re-record.`
    );
  }
  if (next.key !== key) {
    throw new Error(
      `tape: event ${cursor} key mismatch.\n  tape: ${next.kind} "${next.key}"\n  code: ${kind} "${key}"\nRe-record.`
    );
  }
  cursor += 1;
  debug(`tape: replayed [${cursor}/${events.length}] ${kind} ${key}`);
  return next.response;
}

/**
 * Install a fetch shim that routes through the tape. Must be called before
 * any vclaw module calls `fetch`.
 */
export function installFetchShim() {
  if (MODE === "off") return;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const key = `${method} ${url}`;
    if (MODE === "replay") {
      const taped = replayEvent("fetch", key);
      return new MockResponse(taped);
    }
    const res = await realFetch(input, init);
    const body = await res.text();
    recordEvent("fetch", key, {
      status: res.status,
      body,
    });
    return new MockResponse({ status: res.status, body });
  };
}

class MockResponse {
  constructor({ status, body }) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._body = body ?? "";
  }
  async text() {
    return this._body;
  }
  async json() {
    return JSON.parse(this._body);
  }
}
