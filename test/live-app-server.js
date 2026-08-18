import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServer } from "../src/codex.js";

const cwd = process.cwd();

test("live app-server verifies inheritance and partial performance overrides", async () => {
  await withServer({}, async (native) => {
    assert.equal(native.parityReport().effectiveVerified, true);
    assert.equal(native.parityReport().performance.reasoningEffort.source, "native");
    assert.equal(native.parityReport().performance.fastMode.source, "native");
  });

  await withServer({ reasoningEffort: "low" }, async (partial) => {
    const parity = partial.parityReport();
    assert.equal(parity.effectiveVerified, true);
    assert.equal(parity.performance.reasoningEffort.effective, "low");
    assert.equal(parity.performance.reasoningEffort.thread, "low");
    assert.equal(parity.performance.reasoningEffort.verified, true);
    assert.equal(parity.performance.fastMode.source, "native");
  });

  await withServer({ reasoningEffort: "max" }, async (partial) => {
    const parity = partial.parityReport();
    assert.equal(parity.effectiveVerified, true);
    assert.equal(parity.performance.reasoningEffort.effective, "max");
    assert.equal(parity.performance.reasoningEffort.thread, "max");
    assert.equal(parity.performance.reasoningEffort.verified, true);
  });

  await withServer({ fastMode: true }, async (partial) => {
    const parity = partial.parityReport();
    assert.equal(parity.effectiveVerified, true);
    assert.equal(parity.performance.reasoningEffort.source, "native");
    assert.equal(parity.performance.fastMode.serviceTier, "priority");
    assert.equal(parity.performance.fastMode.threadServiceTier, "priority");
    assert.equal(parity.performance.fastMode.verified, true);
  });
});

test("live app-server verifies combined overrides and explicit fast-mode disable", async () => {
  await withServer({ reasoningEffort: "xhigh", fastMode: true }, async (combined) => {
    const parity = combined.parityReport();
    assert.equal(parity.effectiveVerified, true);
    assert.deepEqual(parity.overrides, ["reasoningEffort", "fastMode"]);
    assert.equal(parity.performance.reasoningEffort.effective, "xhigh");
    assert.equal(parity.performance.fastMode.effective, true);
  });

  await withServer({ fastMode: false }, async (disabled) => {
    const parity = disabled.parityReport();
    assert.equal(parity.effectiveVerified, true);
    assert.equal(parity.performance.fastMode.configured, false);
    assert.equal(parity.performance.fastMode.effective, false);
    assert.equal(parity.performance.fastMode.serviceTier, "default");
    assert.equal(parity.performance.fastMode.threadServiceTier, "default");
  });
});

test("live app-server updates one resumed thread after restart and keeps later turns effective", async () => {
  const threadIds = new Set();
  let created;
  let resumed;
  try {
    created = new CodexAppServer({
      cwd,
      codexOverrides: { reasoningEffort: "low", fastMode: false },
      onThreadId: async () => {},
    });
    await created.start();
    const threadId = created.threadId;
    assert.ok(threadId);
    threadIds.add(threadId);
    assert.equal(created.parityReport().effectiveVerified, true);
    const initialTurn = await completedTurn(created, "Reply with exactly PHOTON_CODEX_OVERRIDE_INITIAL_OK and nothing else.");
    assert.equal(initialTurn?.status, "completed");
    await created.stop();

    resumed = new CodexAppServer({
      cwd,
      threadId,
      codexOverrides: { reasoningEffort: "xhigh", fastMode: true },
      onThreadId: async () => {},
    });
    await resumed.start();
    threadIds.add(resumed.threadId);
    assert.equal(resumed.threadId, threadId);
    assert.equal(resumed.parityReport().effectiveVerified, true);
    const turn = await completedTurn(resumed, "Reply with exactly PHOTON_CODEX_OVERRIDE_LIVE_OK and nothing else.");
    assert.equal(turn?.status, "completed");
    const parity = resumed.parityReport();
    assert.equal(parity.effectiveVerified, true);
    assert.equal(parity.performance.reasoningEffort.thread, "xhigh");
    assert.equal(parity.performance.fastMode.threadServiceTier, "priority");
  } finally {
    if (created?.threadId) threadIds.add(created.threadId);
    if (resumed?.threadId) threadIds.add(resumed.threadId);
    const cleanupServer = resumed?.process ? resumed : created?.process ? created : null;
    if (cleanupServer) {
      for (const threadId of threadIds) {
        await cleanupServer.request("thread/archive", { threadId }).catch(() => {});
      }
    }
    if (resumed) await resumed.stop().catch(() => {});
    if (created) await created.stop().catch(() => {});
  }
});

async function withServer(codexOverrides, verify) {
  const server = new CodexAppServer({
    cwd,
    ephemeral: true,
    codexOverrides,
    onThreadId: async () => {},
  });
  try {
    await server.start();
    await verify(server);
  } finally {
    await server.stop();
  }
}

async function completedTurn(server, prompt) {
  let timer;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("live Codex turn timed out")), 120_000);
    const onNotification = (method, params) => {
      if (method !== "turn/completed") return;
      server.off("notification", onNotification);
      resolve(params.turn);
    };
    server.on("notification", onNotification);
  });
  try {
    await server.startTurn([{ type: "text", text: prompt, text_elements: [] }]);
    return await completed;
  } finally {
    clearTimeout(timer);
  }
}
