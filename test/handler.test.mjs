/**
 * Handler-level tests for the pi-git-safeguard extension.
 *
 * Run: node test/handler.test.mjs
 *
 * Loads the real extension (default export) via jiti — same loader pi uses —
 * and fires synthetic `tool_call` events at it. No pi process, no LLM, and no
 * git command is ever executed.
 */

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import("../src/index.ts");
const { default: gitGuardExtension } = mod;

/**
 * Wire up the extension with a fake ExtensionAPI and return helpers
 * for firing tool_call events.
 */
function harness(env = {}) {
  const handlers = {};
  const pi = {
    on(event, handler) {
      handlers[event] = handler;
    },
  };

  const origEnv = process.env.PI_GIT_SAFEGUARD;
  if ("PI_GIT_SAFEGUARD" in env)
    process.env.PI_GIT_SAFEGUARD = env.PI_GIT_SAFEGUARD;
  else delete process.env.PI_GIT_SAFEGUARD;

  gitGuardExtension(pi);

  if (origEnv === undefined) delete process.env.PI_GIT_SAFEGUARD;
  else process.env.PI_GIT_SAFEGUARD = origEnv;

  return {
    fire: async (toolName, input, ctx) =>
      handlers.tool_call?.(
        { type: "tool_call", toolCallId: "test", toolName, input },
        ctx,
      ),
    hasHandlers: Object.keys(handlers).length > 0,
  };
}

function uiHarness({ selectResult } = {}) {
  const calls = [];
  const h = harness();
  const ctx = {
    hasUI: true,
    ui: {
      select: async (title, options, opts) => {
        calls.push({ title, options, opts });
        return typeof selectResult === "function"
          ? selectResult(calls.length)
          : selectResult;
      },
      notify() {},
    },
  };
  return { h, ctx, calls };
}

const noUI = { hasUI: false, ui: { notify() {} } };

/** Test registry — run sequentially, then print a summary. */
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- handler wiring ----

test("registers a tool_call handler", async () => {
  const h = harness();
  assert.ok(h.hasHandlers, "expected pi.on('tool_call', ...) to be called");
});

test("PI_GIT_SAFEGUARD=off registers nothing", async () => {
  const h = harness({ PI_GIT_SAFEGUARD: "off" });
  assert.equal(h.hasHandlers, false);
});

// ---- non-interactive (no UI) ----

test("blocks git push (non-interactive)", async () => {
  const h = harness();
  const result = await h.fire(
    "bash",
    { command: "git push origin main" },
    noUI,
  );
  assert.equal(result.block, true);
  assert.ok(result.reason.includes("git push"), result.reason);
});

test("blocks git commit (non-interactive)", async () => {
  const h = harness();
  const result = await h.fire(
    "bash",
    { command: "git commit -m 'test'" },
    noUI,
  );
  assert.equal(result.block, true);
});

test("allows read-only git log", async () => {
  const h = harness();
  const result = await h.fire("bash", { command: "git log --oneline" }, noUI);
  assert.equal(result, undefined);
});

test("ignores non-bash tools entirely", async () => {
  const h = harness();
  const result = await h.fire(
    "write",
    { path: "x", content: "git push" },
    noUI,
  );
  assert.equal(result, undefined);
});

test("warn mode notifies but does not block", async () => {
  const notifications = [];
  const h = harness({ PI_GIT_SAFEGUARD: "warn" });
  const result = await h.fire(
    "bash",
    { command: "git push" },
    {
      hasUI: false,
      ui: { notify: (msg, type) => notifications.push({ msg, type }) },
    },
  );
  assert.equal(result, undefined);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
});

// ---- interactive (UI) ----

test("user approves → command allowed", async () => {
  const { h, ctx, calls } = uiHarness({
    selectResult: 'Allow once: "git push"',
  });
  const result = await h.fire("bash", { command: "git push" }, ctx);
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options[1], "Block this command");
  assert.ok(
    calls[0].opts.timeout > 0,
    "dialog should have a fail-safe timeout",
  );
});

test("user blocks → blocked with reason", async () => {
  const { h, ctx } = uiHarness({ selectResult: "Block this command" });
  const result = await h.fire("bash", { command: "git push" }, ctx);
  assert.equal(result.block, true);
  assert.ok(!result.reason.includes("timed out"));
});

test("dialog timeout → blocked (fail-safe)", async () => {
  const { h, ctx } = uiHarness({ selectResult: undefined });
  const result = await h.fire("bash", { command: "git push" }, ctx);
  assert.equal(result.block, true);
  assert.ok(result.reason.includes("timed out"));
});

test("allow-once window: approved command replays once, then re-arms", async () => {
  let call = 0;
  const { h, ctx } = uiHarness({
    selectResult: () =>
      ++call === 1 ? 'Allow once: "git push"' : "Block this command",
  });
  const cmd = { command: "git push origin main" };

  const first = await h.fire("bash", cmd, ctx); // user approves
  assert.equal(first, undefined);

  const replay = await h.fire("bash", cmd, ctx); // within window, no prompt
  assert.equal(replay, undefined);

  const third = await h.fire("bash", cmd, ctx); // window consumed → prompt → block
  assert.equal(third.block, true);
});

test("different command after approval still prompts", async () => {
  let call = 0;
  const { h, ctx } = uiHarness({
    selectResult: () => (++call === 1 ? "Allow once" : "Block this command"),
  });
  await h.fire("bash", { command: "git commit -m a" }, ctx); // approve
  const result = await h.fire("bash", { command: "git push" }, ctx); // new cmd → prompt
  assert.equal(result.block, true);
});

// ---- run ----

let passed = 0;
let failed = 0;

console.log("handler tests:");
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
