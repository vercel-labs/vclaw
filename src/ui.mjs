/** Minimal terminal output helpers — no dependencies. */

import { createInterface } from "node:readline";
import { isRecord, isReplay, recordEvent, replayEvent } from "./tape.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

const noColor = !!process.env.NO_COLOR;

function c(color, text) {
  return noColor ? text : `${color}${text}${RESET}`;
}

export function log(msg) {
  console.log(msg);
}

export function step(label) {
  console.log(c(CYAN, `▸ ${label}`));
}

export function success(msg) {
  console.log(c(GREEN, `✓ ${msg}`));
}

export function warn(msg) {
  console.log(c(YELLOW, `⚠ ${msg}`));
}

export function fail(msg) {
  console.error(c(RED, `✗ ${msg}`));
}

export function dim(msg) {
  return c(DIM, msg);
}

export function bold(msg) {
  return c(BOLD, msg);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(label) {
  const stream = process.stdout;
  const canAnimate = Boolean(stream.isTTY) && !process.env.CI;

  if (!canAnimate) {
    console.log(c(CYAN, `▸ ${label}`));
    return {
      update(next) {
        console.log(c(CYAN, `▸ ${next}`));
      },
      succeed(msg = label) {
        console.log(c(GREEN, `✓ ${msg}`));
      },
      fail(msg = label) {
        console.error(c(RED, `✗ ${msg}`));
      },
    };
  }

  let current = label;
  let frame = 0;
  const render = () => {
    const cols = stream.columns || 80;
    // Reserve 2 cols for the spinner glyph + space; keep 1 col as safety
    // margin so the terminal never wraps the line and \r can fully clear it.
    const max = Math.max(10, cols - 4);
    const truncated =
      current.length > max ? `${current.slice(0, max - 1)}…` : current;
    const text = `${c(CYAN, SPINNER_FRAMES[frame])} ${truncated}`;
    stream.write(`\r\x1b[2K${text}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  render();
  const interval = setInterval(render, 80);

  const stop = (symbol, msg) => {
    clearInterval(interval);
    const cols = stream.columns || 80;
    const max = Math.max(10, cols - 4);
    const truncated = msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
    stream.write(`\r\x1b[2K${symbol} ${truncated}\n`);
  };

  return {
    update(next) {
      current = next;
    },
    succeed(msg = current) {
      stop(c(GREEN, "✓"), msg);
    },
    fail(msg = current) {
      stop(c(RED, "✗"), msg);
    },
  };
}

export function isInteractive() {
  // Replay mode mimics the original interactive run so the same prompt
  // events in the tape get consumed, even when we're running under a pipe
  // or in CI. Record mode still honors the real TTY state so we don't
  // record prompts that didn't actually fire.
  if (isReplay()) return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function prompt(question, defaultValue = "") {
  if (isReplay()) {
    const taped = replayEvent("prompt", question);
    return taped ?? defaultValue;
  }
  if (!isInteractive()) {
    if (isRecord()) recordEvent("prompt", question, defaultValue);
    return defaultValue;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${dim(`(${defaultValue})`)}` : "";
  const cleanup = () => {
    try {
      rl.close();
    } catch {
      // ignore
    }
  };
  const onSigint = () => {
    cleanup();
    process.stdout.write("\n");
    console.error(c(YELLOW, "Cancelled."));
    process.exit(130);
  };
  rl.on("SIGINT", onSigint);
  try {
    const answer = await new Promise((resolve) => {
      rl.question(`${c(CYAN, "?")} ${question}${suffix} `, resolve);
    });
    const trimmed = answer.trim();
    const resolved = trimmed || defaultValue;
    if (isRecord()) recordEvent("prompt", question, resolved);
    return resolved;
  } finally {
    rl.removeListener("SIGINT", onSigint);
    cleanup();
  }
}

export async function promptMasked(question) {
  if (isReplay()) {
    const taped = replayEvent("prompt", question);
    return taped ?? "";
  }
  if (!isInteractive()) {
    throw new Error(`${question}: masked input requires an interactive terminal`);
  }
  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== "function") {
    throw new Error(`${question}: stdin is not a TTY — cannot mask input`);
  }

  process.stdout.write(`${c(CYAN, "?")} ${question}: `);

  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let buffer = "";
  return new Promise((resolvePromise) => {
    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (!wasRaw) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          process.stdout.write("\n");
          cleanup();
          if (isRecord()) recordEvent("prompt", question, buffer);
          resolvePromise(buffer);
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          console.error(c(YELLOW, "Cancelled."));
          process.exit(130);
        }
        if (code === 127 || code === 8) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue;
        buffer += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}
