import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex.js";

const fixture = fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url));

function fixtureServer(t, options = {}) {
  const spawn = childProcess.spawn;
  const mocked = t.mock.method(childProcess, "spawn", (_command, _args, opts) =>
    spawn(process.execPath, [fixture], opts));
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  const server = new CodexAppServer({ cwd: process.cwd(), onThreadId: async () => {}, ...options });
  const request = server.request.bind(server);
  server.request = (method, params, timeout = 2000) => request(method, params, timeout);
  t.after(() => server.stop());
  return server;
}

test("resumes a large thread without waiting for unused history, then continues it", async (t) => {
  const saved = [];
  const server = fixtureServer(t, {
    threadId: "existing-thread",
    transportInstructions: "existing transport contract",
    onThreadId: async (id) => saved.push(id),
  });
  await server.start();
  assert.equal(server.threadId, "existing-thread");
  assert.equal(server.parityReport().effectiveVerified, true);
  assert.equal((await server.startTurn([{ type: "text", text: "continue" }])).turn.id, "turn-1");
  assert.deepEqual(saved, ["existing-thread", "existing-thread"]);
});

test("drains a noisy backend's stderr even when debug logging is disabled", async (t) => {
  const server = fixtureServer(t, {
    env: { ...process.env, PHOTON_CODEX_DEBUG: "0", CODEX_TEST_NOISY: "1" },
  });
  await server.start();
  assert.equal(server.parityReport().effectiveVerified, true);
});

test("backend exit rejects all pending requests and cancels their deadlines", async (t) => {
  const server = fixtureServer(t);
  await server.start();
  const cleared = new Set();
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    cleared.add(timer);
    return clear(timer);
  });
  const pending = server.request("test/wait", {});
  const exiting = server.request("test/exit", {});
  const deadlines = [...server.pending.values()].map(({ timer }) => timer);
  const results = await Promise.allSettled([pending, exiting]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /app-server exited/);
  }
  assert.equal(server.pending.size, 0);
  assert.ok(deadlines.every((timer) => cleared.has(timer)));
});

test("a failed request write leaves no pending request or deadline", async () => {
  const server = new CodexAppServer({ cwd: process.cwd(), onThreadId: async () => {} });
  await assert.rejects(server.request("config/read", {}, 2000), /not running/);
  assert.equal(server.pending.size, 0);
});
