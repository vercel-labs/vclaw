import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGatewayContext } from "./chat.mjs";

const SAMPLE_CONTEXT = {
  sandboxOrigin: "https://oc-prj-abc.vercel.run",
  gatewayToken: "tok_123",
  heartbeatIntervalMs: 15000,
};

function htmlWithContext(ctx) {
  const json = JSON.stringify(ctx);
  return `<!DOCTYPE html><html><head><script>
(function() {
  var CONTEXT = ${json};
  var SANDBOX_ORIGIN = CONTEXT.sandboxOrigin;
  var GATEWAY_TOKEN = CONTEXT.gatewayToken;
})();
</script></head><body>ok</body></html>`;
}

test("parseGatewayContext extracts sandboxOrigin + gatewayToken from injected script", () => {
  const ctx = parseGatewayContext(htmlWithContext(SAMPLE_CONTEXT));
  assert.equal(ctx.sandboxOrigin, SAMPLE_CONTEXT.sandboxOrigin);
  assert.equal(ctx.gatewayToken, SAMPLE_CONTEXT.gatewayToken);
});

test("parseGatewayContext throws when the marker is absent", () => {
  assert.throws(
    () => parseGatewayContext("<!DOCTYPE html><html><body>no script</body></html>"),
    /Could not locate gateway handoff/
  );
});

test("parseGatewayContext throws when required fields are missing", () => {
  const html = htmlWithContext({ heartbeatIntervalMs: 1000 });
  assert.throws(
    () => parseGatewayContext(html),
    /missing sandboxOrigin or gatewayToken/
  );
});

test("parseGatewayContext throws on invalid JSON", () => {
  const html = `<script>var CONTEXT = {not json};</script>`;
  assert.throws(() => parseGatewayContext(html), /Invalid gateway handoff JSON/);
});
