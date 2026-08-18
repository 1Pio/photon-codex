import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Bridge, normalizePhone, parseOutboundResponse, safeName, splitMessage } from "../src/bridge.js";
import { CodexAppServer, FAST_SERVICE_TIER } from "../src/codex.js";
import {
  codexReasoningEffort,
  emptyState,
  loadConfig,
  normalizeFastMode,
  normalizeReasoningEffort,
  normalizeSender,
  normalizeState,
  saveConfig,
} from "../src/config.js";
import { launchAgentPlist } from "../src/service.js";

test("normalizes E.164 input without weakening validation", () => {
  assert.equal(normalizeSender("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("+971 58 123 4567"), "+971581234567");
  assert.throws(() => normalizeSender("555-1234"));
});

test("normalizes friendly reasoning effort labels to Codex values", () => {
  assert.equal(normalizeReasoningEffort("light"), "light");
  assert.equal(normalizeReasoningEffort(" Extra High "), "extra high");
  assert.equal(normalizeReasoningEffort("xhigh"), "extra high");
  assert.equal(codexReasoningEffort("light"), "low");
  assert.equal(codexReasoningEffort("extra high"), "xhigh");
  assert.equal(codexReasoningEffort("max"), "max");
  assert.throws(() => normalizeReasoningEffort("ultra"), /light, medium, high, extra high, max/);
});

test("requires fastMode to be a JSON boolean", () => {
  assert.equal(normalizeFastMode(true), true);
  assert.equal(normalizeFastMode(false), false);
  assert.throws(() => normalizeFastMode("false"), /boolean/);
});

test("persists and loads reasoning effort and disabled fast mode", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-config-"));
  const env = { PHOTON_CODEX_HOME: home };
  try {
    await saveConfig({
      projectId: "project",
      allowedSender: "+15551234567",
      cwd: path.join(home, "workspace"),
      reasoningEffort: "extra high",
      fastMode: false,
    }, env);

    const stored = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    const loaded = await loadConfig(env);
    assert.equal(stored.reasoningEffort, "extra high");
    assert.equal(stored.fastMode, false);
    assert.equal(loaded.reasoningEffort, "extra high");
    assert.equal(loaded.fastMode, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("defaults legacy configs to medium reasoning with fast mode enabled", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-legacy-config-"));
  const env = { PHOTON_CODEX_HOME: home };
  try {
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      projectId: "project",
      allowedSender: "+15551234567",
      cwd: path.join(home, "workspace"),
    }));

    const loaded = await loadConfig(env);
    assert.equal(loaded.reasoningEffort, "medium");
    assert.equal(loaded.fastMode, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("sanitizes inbound filenames", () => {
  assert.equal(safeName("../../private file.pdf"), "_.._private_file.pdf");
  assert.equal(safeName(""), "file");
});

test("splits long replies without losing text", () => {
  const source = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
  const chunks = splitMessage(source, 40);
  assert.deepEqual(chunks, ["a".repeat(30), "b".repeat(30)]);
});

test("extracts a private Photon reaction directive from a response", () => {
  assert.deepEqual(parseOutboundResponse("[[photon_reaction:🦦]]"), { reaction: "🦦", text: "" });
  assert.deepEqual(parseOutboundResponse("[[photon_reaction:🫡]]\nWorking on it."), {
    reaction: "🫡",
    text: "Working on it.",
  });
  assert.deepEqual(parseOutboundResponse("Normal reply"), { reaction: null, text: "Normal reply" });
});

test("ignores Photon read receipts before starting a Codex turn", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-receipt-"));
  try {
    let turnsStarted = 0;
    const bridge = new Bridge({
      config: {
        projectId: "project",
        allowedSender: "+15551234567",
        cwd: home,
        maxAttachmentBytes: 1024,
      },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.codex = {
      startTurn: async () => {
        turnsStarted += 1;
        return { turn: { id: "turn-receipt" } };
      },
    };
    const space = {
      id: "space-1",
      type: "dm",
      startTyping: async () => {},
      stopTyping: async () => {},
    };
    const receipt = {
      id: "message-1:read:1",
      direction: "inbound",
      sender: { id: "+15551234567" },
      timestamp: new Date("2026-08-18T18:14:01.093Z"),
      content: { type: "read", target: { direction: "outbound" } },
      read: async () => {},
    };

    await bridge.handleMessage(space, receipt);

    assert.equal(turnsStarted, 0);
    assert.deepEqual(bridge.state.acceptedMessageIds, []);
    assert.equal(bridge.state.runtime.ignoredEvents, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("accepts one user message and records one successful reply", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-message-"));
  try {
    const inputs = [];
    const replies = [];
    const reactions = [];
    const bridge = new Bridge({
      config: {
        projectId: "project",
        allowedSender: "+15551234567",
        cwd: home,
        maxAttachmentBytes: 1024,
      },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.codex = {
      startTurn: async (input) => {
        inputs.push(input);
        return { turn: { id: "turn-1" } };
      },
    };
    const space = {
      id: "space-1",
      type: "dm",
      startTyping: async () => {},
      stopTyping: async () => {},
    };
    bridge.space = space;
    const message = {
      id: "message-1",
      direction: "inbound",
      sender: { id: "+15551234567" },
      timestamp: new Date("2026-08-19T00:00:00.000Z"),
      content: { type: "text", text: "hello" },
      read: async () => {},
      react: async (emoji) => { reactions.push(emoji); },
      reply: async (content) => { replies.push(content); },
      space,
    };

    await bridge.handleMessage(space, message);
    bridge.finalByTurn.set("turn-1", "[[photon_reaction:🫡]]\nhello back");
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    assert.equal(inputs.length, 1);
    assert.match(inputs[0][0].text, /hello$/);
    assert.equal(replies.length, 1);
    assert.deepEqual(reactions, ["🫡"]);
    assert.deepEqual(bridge.state.acceptedMessageIds, ["message-1"]);
    assert.deepEqual(bridge.state.repliedMessageIds, ["message-1"]);
    assert.equal(bridge.state.runtime.acceptedMessages, 1);
    assert.equal(bridge.state.runtime.repliesSent, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status distinguishes configured, next-turn, and current effective effort", () => {
  const bridge = new Bridge({
    config: {
      projectId: "project",
      allowedSender: "+15551234567",
      cwd: "/tmp",
      maxAttachmentBytes: 1024,
      reasoningEffort: "extra high",
      fastMode: true,
    },
    projectSecret: "secret",
  });
  bridge.state = emptyState();
  bridge.codex = {
    threadId: "thread-1",
    reasoningEffort: "xhigh",
    effectiveReasoningEffort: "medium",
    serviceTier: "priority",
  };

  const status = bridge.status();
  assert.equal(status.reasoningEffort, "extra high");
  assert.equal(status.nextTurnReasoningEffort, "xhigh");
  assert.equal(status.effectiveReasoningEffort, "medium");
  assert.equal(status.fastMode, true);
  assert.equal(status.priority, true);
});

test("migrates legacy state without retaining receipt events as messages", () => {
  const migrated = normalizeState({
    version: 1,
    threadId: "thread-1",
    seenMessageIds: ["message-1", "message-1:read:9", "message-2:reaction:2:0"],
  });

  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.acceptedMessageIds, ["message-1", "message-2:reaction:2:0"]);
  assert.deepEqual(migrated.ignoredEventIds, ["message-1:read:9"]);
  assert.equal(migrated.runtime.acceptedMessages, 2);
  assert.equal(migrated.runtime.ignoredEvents, 1);
  assert.equal(JSON.stringify(migrated).includes("seenMessageIds"), false);
});

test("launch service contains no Photon secret and restarts only after failure", () => {
  const plist = launchAgentPlist({
    ...process.env,
    PHOTON_CODEX_HOME: "/tmp/photon-codex-home",
    PHOTON_PROJECT_SECRET: "must-not-appear",
  });

  assert.equal(plist.includes("must-not-appear"), false);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.match(plist, /<string>run<\/string>/);
});

test("starts each turn on the loaded thread without resuming again", async () => {
  const saved = [];
  const codex = new CodexAppServer({ cwd: "/tmp", threadId: "thread-1", onThreadId: async (id) => saved.push(id) });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    return { turn: { id: "turn-1" } };
  };

  await codex.startTurn([{ type: "text", text: "hello" }]);

  assert.deepEqual(requests.map(({ method }) => method), ["turn/start"]);
  assert.equal(requests[0].params.serviceTier, FAST_SERVICE_TIER);
  assert.deepEqual(saved, ["thread-1"]);
});

test("does not persist an empty Codex thread before its first turn", async () => {
  const saved = [];
  const codex = new CodexAppServer({ cwd: "/tmp", onThreadId: async (id) => saved.push(id) });
  codex.request = async (method) => method === "thread/start"
    ? { thread: { id: "thread-new" } }
    : { turn: { id: "turn-1" } };

  await codex.newThread();
  assert.deepEqual(saved, []);
  await codex.startTurn([{ type: "text", text: "hello" }]);
  assert.deepEqual(saved, ["thread-new"]);
});

test("fails closed when a persisted Codex thread cannot resume", async () => {
  const codex = new CodexAppServer({ cwd: "/tmp", threadId: "thread-missing", onThreadId: async () => {} });
  const methods = [];
  codex.request = async (method) => {
    methods.push(method);
    throw new Error("no rollout found");
  };

  await assert.rejects(() => codex.ensureThread(), /Cannot resume Codex thread thread-missing/);
  assert.deepEqual(methods, ["thread/resume"]);
});

test("resumes persisted threads in fast service mode", async () => {
  const codex = new CodexAppServer({ cwd: "/tmp", threadId: "thread-1", onThreadId: async () => {} });
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return { thread: { id: "thread-1" }, serviceTier: "priority" };
  };

  await codex.ensureThread();

  assert.equal(request.method, "thread/resume");
  assert.equal(request.params.serviceTier, FAST_SERVICE_TIER);
  assert.equal(codex.serviceTier, "priority");
});

test("requests fast service and records app-server priority mode", async () => {
  const codex = new CodexAppServer({ cwd: "/tmp", onThreadId: async () => {} });
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return { thread: { id: "thread-fast" }, serviceTier: "priority" };
  };

  await codex.newThread();

  assert.equal(request.method, "thread/start");
  assert.equal(request.params.serviceTier, FAST_SERVICE_TIER);
  assert.equal(codex.serviceTier, "priority");
});

test("applies configured effort and explicitly clears fast service when disabled", async () => {
  const codex = new CodexAppServer({
    cwd: "/tmp",
    reasoningEffort: "xhigh",
    fastMode: false,
    onThreadId: async () => {},
  });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-standard" } };
    return { turn: { id: "turn-standard" } };
  };

  await codex.newThread();
  await codex.startTurn([{ type: "text", text: "hello" }]);

  assert.deepEqual(requests.map(({ method }) => method), ["thread/start", "turn/start"]);
  assert.equal(requests[0].params.serviceTier, null);
  assert.equal(requests[1].params.serviceTier, null);
  assert.equal(requests[1].params.effort, "xhigh");
  assert.equal(codex.effectiveReasoningEffort, "xhigh");
});

test("clears inherited fast service when resuming with fast mode disabled", async () => {
  const codex = new CodexAppServer({
    cwd: "/tmp",
    threadId: "thread-standard",
    fastMode: false,
    onThreadId: async () => {},
  });
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return { thread: { id: "thread-standard" }, serviceTier: null };
  };

  await codex.ensureThread();

  assert.equal(request.method, "thread/resume");
  assert.equal(request.params.serviceTier, null);
  assert.equal(codex.serviceTier, null);
});
