/** Minimal terminal output helpers — no dependencies. */

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
