let enabled = Boolean(process.env.VCLAW_DEBUG);

export function setDebug(value) {
  enabled = Boolean(value);
  if (enabled) process.env.VCLAW_DEBUG = "1";
}

export function isDebug() {
  return enabled;
}

function timestamp() {
  const now = new Date();
  return now.toISOString().slice(11, 23);
}

export function debug(label, detail) {
  if (!enabled) return;
  const prefix = `\x1b[2m[${timestamp()}] [debug]\x1b[0m ${label}`;
  if (detail === undefined) {
    console.error(prefix);
    return;
  }
  if (typeof detail === "string") {
    console.error(`${prefix} ${detail}`);
    return;
  }
  try {
    console.error(`${prefix} ${JSON.stringify(detail)}`);
  } catch {
    console.error(prefix, detail);
  }
}
