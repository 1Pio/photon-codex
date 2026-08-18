import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Bridge, normalizePhone, parseOutboundResponse, safeName, splitApprovalPrompt, splitMessage } from "../src/bridge.js";
import { CodexAppServer, codexEnvironment, codexExecutable } from "../src/codex.js";
import {
  emptyState,
  loadConfig,
  normalizeSender,
  normalizeState,
  saveConfig,
} from "../src/config.js";
import { formatServerRequest, resolveServerRequest, supportsServerRequest } from "../src/interaction.js";
import { launchAgentPlist } from "../src/service.js";

test("normalizes E.164 input without weakening validation", () => {
  assert.equal(normalizeSender("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.throws(() => normalizeSender("555-1234"));
});

test("persists only Photon transport configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-config-"));
  const env = {
    PHOTON_CODEX_HOME: home,
    PHOTON_CODEX_REASONING_EFFORT: "light",
    PHOTON_CODEX_FAST_MODE: "false",
  };
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
    assert.deepEqual(Object.keys(stored).sort(), ["allowedSender", "cwd", "maxAttachmentBytes", "projectId"]);
    assert.equal("reasoningEffort" in loaded, false);
    assert.equal("fastMode" in loaded, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ignores legacy Codex overrides in Photon config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-legacy-config-"));
  const env = { PHOTON_CODEX_HOME: home };
  try {
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      projectId: "project",
      allowedSender: "+15551234567",
      cwd: path.join(home, "workspace"),
      reasoningEffort: "extra high",
      fastMode: true,
    }));

    const loaded = await loadConfig(env);
    assert.deepEqual(Object.keys(loaded).sort(), ["allowedSender", "cwd", "maxAttachmentBytes", "projectId"]);
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

test("paginates approval scope losslessly", () => {
  const source = `Exact scope:\n${"x".repeat(3473)}😀 quoted command  ${"y".repeat(3600)}`;
  const chunks = splitApprovalPrompt(source, 3500);
  const reconstructed = chunks.map((chunk) => chunk.replace(/^Approval \d+\/\d+\n/, "")).join("");

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^Approval \d+\/\d+\n[\uDC00-\uDFFF]/.test(chunk)));
  assert.equal(reconstructed, source);
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
    assert.equal(inputs[0][0].text, "hello");
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

test("accepts and unwraps a threaded iMessage reply", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-threaded-reply-"));
  try {
    const inputs = [];
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: "+15551234567", cwd: home, maxAttachmentBytes: 1024 },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.codex = {
      startTurn: async (input) => {
        inputs.push(input);
        return { turn: { id: "turn-reply" } };
      },
    };
    const space = { id: "space-1", type: "dm", startTyping: async () => {}, stopTyping: async () => {} };
    const message = {
      id: "reply-1",
      direction: "inbound",
      sender: { id: "+15551234567" },
      content: {
        type: "reply",
        target: { id: "prompt-1" },
        content: { type: "text", text: "threaded answer" },
      },
      read: async () => {},
      space,
    };

    await bridge.handleMessage(space, message);

    assert.equal(inputs[0][0].text, "threaded answer");
    assert.deepEqual(bridge.state.acceptedMessageIds, ["reply-1"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("never applies a late threaded answer to the current Codex prompt", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-late-reply-"));
  try {
    let responses = 0;
    const replies = [];
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: "+15551234567", cwd: home, maxAttachmentBytes: 1024 },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.codex = { respond: () => { responses += 1; } };
    bridge.pendingRequests = [{
      id: 2,
      method: "item/commandExecution/requestApproval",
      params: { command: "current" },
      promptIds: ["current-prompt"],
      requiresThreadedReply: false,
    }];
    bridge.expiredPromptIds.set("closed-prompt", Date.now() + 60_000);
    const space = { id: "space-1", type: "dm" };
    const message = {
      id: "late-reply",
      direction: "inbound",
      sender: { id: "+15551234567" },
      content: {
        type: "reply",
        target: { id: "closed-prompt" },
        content: { type: "text", text: "allow" },
      },
      read: async () => {},
      reply: async (content) => { replies.push(content); },
      space,
    };

    await bridge.handleMessage(space, message);

    assert.equal(responses, 0);
    assert.equal(bridge.pendingRequests.length, 1);
    assert.equal(replies.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("honors the Codex desktop follow-up queue setting", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-queue-"));
  try {
    let steered = 0;
    const started = [];
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
    bridge.activeTurnId = "turn-active";
    bridge.codex = {
      configSummary: () => ({ followUpQueueMode: "queue" }),
      steer: async () => { steered += 1; },
      startTurn: async (input) => {
        started.push(input);
        return { turn: { id: "turn-next" } };
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
      id: "message-queued",
      direction: "inbound",
      sender: { id: "+15551234567" },
      timestamp: new Date("2026-08-19T00:00:00.000Z"),
      content: { type: "text", text: "next request" },
      read: async () => {},
      space,
    };

    await bridge.handleMessage(space, message);

    assert.equal(steered, 0);
    assert.equal(bridge.messageQueue.length, 1);
    assert.equal(bridge.messageQueue[0].input[0].text, "next request");
    assert.deepEqual(bridge.state.acceptedMessageIds, ["message-queued"]);
    assert.deepEqual(bridge.state.messageQueue, [{ messageId: "message-queued", input: bridge.messageQueue[0].input }]);

    await bridge.handleCodexNotification("turn/completed", { turn: { id: "turn-active", status: "completed" } });

    assert.equal(started.length, 1);
    assert.equal(bridge.activeTurnId, "turn-next");
    assert.deepEqual(bridge.state.messageQueue, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status reports native Codex config parity without Photon overrides", () => {
  const bridge = new Bridge({
    config: {
      projectId: "project",
      allowedSender: "+15551234567",
      cwd: "/tmp",
      maxAttachmentBytes: 1024,
    },
    projectSecret: "secret",
  });
  bridge.state = emptyState();
  bridge.codex = {
    threadId: "thread-1",
    account: { authenticated: true, type: "chatgpt", planType: "pro" },
    parityReport: () => ({ verified: true, overrides: [], mismatches: [] }),
  };

  const status = bridge.status();
  assert.equal(status.configParity.verified, true);
  assert.deepEqual(status.configParity.overrides, []);
  assert.equal(status.account.type, "chatgpt");
  assert.equal(status.pendingCodexRequests, 0);
});

test("migrates legacy state and starts a fresh native-config thread", () => {
  const migrated = normalizeState({
    version: 1,
    threadId: "thread-1",
    seenMessageIds: ["message-1", "message-1:read:9", "message-2:reaction:2:0"],
  });

  assert.equal(migrated.version, 3);
  assert.equal(migrated.threadId, null);
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
  assert.match(plist, /<key>PHOTON_CODEX_BIN<\/key>/);
  assert.match(plist, /<key>CODEX_HOME<\/key>/);
});

test("launch service preserves PATH lookup when no absolute Codex executable is pinned", () => {
  const plist = launchAgentPlist({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PHOTON_CODEX_HOME: "/tmp/photon-codex-home",
    PHOTON_CODEX_BIN: "codex",
  });

  assert.equal(plist.includes("<key>PHOTON_CODEX_BIN</key>"), false);
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
  assert.deepEqual(Object.keys(requests[0].params).sort(), ["input", "threadId"]);
  assert.deepEqual(saved, ["thread-1"]);
});

test("starts a thread with only cwd and injects transport instructions separately", async () => {
  const codex = configuredCodex({ transportInstructions: "transport only" });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") return inheritedThread("thread-new");
    return {};
  };

  await codex.newThread();

  assert.deepEqual(requests.map(({ method }) => method), ["thread/start", "thread/inject_items"]);
  assert.deepEqual(requests[0].params, { cwd: "/tmp" });
  assert.equal(requests[1].params.items[0].role, "developer");
  assert.equal(requests[1].params.items[0].content[0].text, "transport only");
  assert.equal(codex.parityReport().verified, true);
  assert.deepEqual(codex.parityReport().overrides, []);
});

test("persists a new Codex thread immediately so restart cannot rotate it", async () => {
  const saved = [];
  const codex = configuredCodex({ onThreadId: async (id) => saved.push(id) });
  codex.request = async (method) => method === "thread/start"
    ? inheritedThread("thread-new")
    : { turn: { id: "turn-1" } };

  await codex.newThread();
  assert.deepEqual(saved, ["thread-new"]);
  await codex.startTurn([{ type: "text", text: "hello" }]);
  assert.deepEqual(saved, ["thread-new", "thread-new"]);
});

test("starts a new thread when configured settings are not reported by the protocol", async () => {
  const codex = configuredCodex();
  codex.effectiveConfig.model_reasoning_summary = "detailed";
  codex.request = async (method) => method === "thread/start"
    ? inheritedThread("thread-new")
    : {};

  await codex.newThread();

  assert.equal(codex.threadId, "thread-new");
  assert.equal(codex.parityReport().inherited, true);
  assert.equal(codex.parityReport().verified, false);
  assert.deepEqual(codex.parityReport().unreported, ["reasoningSummary"]);
});

test("fails closed when a persisted Codex thread cannot resume", async () => {
  const codex = configuredCodex({ threadId: "thread-missing" });
  const methods = [];
  codex.request = async (method) => {
    methods.push(method);
    throw new Error("no rollout found");
  };

  await assert.rejects(() => codex.ensureThread(), /Cannot resume Codex thread thread-missing/);
  assert.deepEqual(methods, ["thread/resume"]);
});

test("resumes persisted threads without Codex setting overrides", async () => {
  const codex = configuredCodex({ threadId: "thread-1" });
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return inheritedThread("thread-1");
  };

  await codex.ensureThread();

  assert.equal(request.method, "thread/resume");
  assert.deepEqual(request.params, { threadId: "thread-1", cwd: "/tmp" });
  assert.equal(codex.parityReport().verified, true);
});

test("does not replace a resumed thread when optional settings are unreported", async () => {
  const codex = configuredCodex({ threadId: "thread-1" });
  const methods = [];
  codex.request = async (method) => {
    methods.push(method);
    return { ...inheritedThread("thread-1"), reasoningEffort: null };
  };

  await codex.ensureThread();

  assert.deepEqual(methods, ["thread/resume"]);
  assert.equal(codex.threadId, "thread-1");
  assert.equal(codex.parityReport().inherited, true);
  assert.equal(codex.parityReport().verified, false);
  assert.deepEqual(codex.parityReport().unreported, ["reasoningEffort"]);
});

test("replaces a persisted thread whose settings do not match native config", async () => {
  const codex = configuredCodex({ threadId: "thread-old" });
  const methods = [];
  codex.request = async (method, params) => {
    methods.push({ method, params });
    if (method === "thread/resume") return { ...inheritedThread("thread-old"), approvalPolicy: "never" };
    return inheritedThread("thread-native");
  };

  await codex.ensureThread();

  assert.deepEqual(methods.map(({ method }) => method), ["thread/resume", "thread/start"]);
  assert.equal(codex.threadId, "thread-native");
  assert.equal(codex.parityReport().verified, true);
});

test("maps Codex approvals to compact iMessage decisions", () => {
  const request = {
    method: "item/commandExecution/requestApproval",
    params: { command: "git push", reason: "publish the verified change" },
  };

  assert.match(formatServerRequest(request), /git push/);
  assert.deepEqual(resolveServerRequest(request, "allow"), { decision: "accept" });
  assert.deepEqual(resolveServerRequest(request, "always"), { decision: "acceptForSession" });
  assert.deepEqual(resolveServerRequest(request, "deny"), { decision: "decline" });
});

test("renders complete command and file approval scope without truncation", () => {
  const suffix = "sensitive-suffix";
  const command = {
    method: "item/commandExecution/requestApproval",
    params: {
      command: `printf '%s' '${"x".repeat(5000)}${suffix}'`,
      cwd: "/private/workspace",
      proposedExecpolicyAmendment: { command: "printf" },
    },
  };
  const file = {
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-1",
      changes: [{ path: "/private/workspace/file.txt", kind: "update", diff: "+secret scope" }],
    },
  };

  assert.match(formatServerRequest(command), /sensitive-suffix/);
  assert.match(formatServerRequest(command), /private\/workspace/);
  assert.match(formatServerRequest(command), /proposedExecpolicyAmendment/);
  assert.equal(supportsServerRequest(file), true);
  assert.match(formatServerRequest(file), /\+secret scope/);
});

test("fails closed for secret questions, unscoped file approvals, and unsupported app schemas", () => {
  assert.equal(supportsServerRequest({
    method: "item/tool/requestUserInput",
    params: { questions: [{ id: "token", question: "Token", isSecret: true }] },
  }), false);
  assert.equal(supportsServerRequest({
    method: "item/fileChange/requestApproval",
    params: { itemId: "item-without-patch" },
  }), false);
  assert.equal(supportsServerRequest({
    method: "mcpServer/elicitation/request",
    params: { mode: "openai/form", requestedSchema: { opaque: true } },
  }), false);
});

test("captures exact file changes from the always-on item lifecycle", async () => {
  const bridge = new Bridge({
    config: { projectId: "project", allowedSender: "+15551234567", cwd: "/tmp", maxAttachmentBytes: 1024 },
    projectSecret: "secret",
  });
  const changes = [{ path: "/tmp/file.txt", kind: "update", diff: "+hello" }];

  await bridge.handleCodexNotification("item/started", {
    item: { id: "file-item", type: "fileChange", changes, status: "inProgress" },
  });

  assert.deepEqual(bridge.fileChanges.get("file-item"), changes);
});

test("uses the current legacy denial response shape", () => {
  assert.deepEqual(resolveServerRequest({ method: "execCommandApproval", params: {} }, "deny"), {
    decision: { denied: { rejection: "Denied by the user over iMessage." } },
  });
});

test("maps user-input and permission prompts back to app-server responses", () => {
  const inputRequest = {
    method: "item/tool/requestUserInput",
    params: {
      questions: [{
        id: "mode",
        question: "Choose mode",
        isOther: false,
        options: [{ label: "Safe", description: "bounded" }, { label: "Fast", description: "faster" }],
      }],
    },
  };
  const permissionRequest = {
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true }, fileSystem: null } },
  };

  assert.deepEqual(resolveServerRequest(inputRequest, "2"), {
    answers: { mode: { answers: ["Fast"] } },
  });
  assert.deepEqual(resolveServerRequest(permissionRequest, "always"), {
    permissions: { network: { enabled: true }, fileSystem: null },
    scope: "session",
  });
  assert.deepEqual(resolveServerRequest(permissionRequest, "deny"), {
    permissions: {},
    scope: "turn",
  });
  assert.match(formatServerRequest({
    ...permissionRequest,
    params: { ...permissionRequest.params, cwd: "/private/workspace", environmentId: "env-1" },
  }), /private\/workspace[\s\S]*env-1/);
});

test("maps MCP form elicitation from key-value iMessage input", () => {
  const request = {
    method: "mcpServer/elicitation/request",
    params: {
      mode: "form",
      message: "Confirm details",
      requestedSchema: {
        type: "object",
        properties: { count: { type: "integer" }, enabled: { type: "boolean" } },
        required: ["count", "enabled"],
      },
    },
  };

  assert.deepEqual(resolveServerRequest(request, "count=3\nenabled=yes"), {
    action: "accept",
    content: { count: 3, enabled: true },
    _meta: null,
  });
});

test("rejects MCP form values that violate the advertised schema", () => {
  const request = {
    method: "mcpServer/elicitation/request",
    params: {
      mode: "form",
      message: "Confirm details",
      requestedSchema: {
        type: "object",
        additionalProperties: false,
        properties: { count: { type: "integer", minimum: 2, maximum: 4 } },
        required: ["count"],
      },
    },
  };

  assert.throws(() => resolveServerRequest(request, "count=9"), /above the maximum/);
  assert.throws(() => resolveServerRequest(request, '{"count":3,"hidden":true}'), /Unknown field/);
});

test("supports the complete standard MCP enum and format schema families", () => {
  const request = {
    method: "mcpServer/elicitation/request",
    params: {
      mode: "form",
      message: "Profile",
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
          mode: { type: "string", oneOf: [{ const: "safe", title: "Safe" }, { const: "fast", title: "Fast" }] },
          tags: { type: "array", items: { anyOf: [{ const: "one", title: "One" }, { const: "two", title: "Two" }] } },
        },
        required: ["email", "mode", "tags"],
      },
    },
  };

  assert.equal(supportsServerRequest(request), true);
  assert.deepEqual(resolveServerRequest(request, "email=a@example.com\nmode=safe\ntags=one,two").content, {
    email: "a@example.com",
    mode: "safe",
    tags: ["one", "two"],
  });
  assert.throws(() => resolveServerRequest(request, "email=invalid\nmode=safe\ntags=one"), /valid email/);
});

test("removes Photon-only values from the Codex child environment", () => {
  assert.deepEqual(codexEnvironment({
    PATH: "/usr/bin",
    CODEX_HOME: "/tmp/codex-home",
    PHOTON_PROJECT_SECRET: "secret",
    PHOTON_CODEX_HOME: "/tmp/photon-home",
  }), {
    PATH: "/usr/bin",
    CODEX_HOME: "/tmp/codex-home",
  });
});

test("prefers the Codex desktop app executable on macOS", () => {
  assert.equal(codexExecutable({ PHOTON_CODEX_BIN: "/opt/codex/bin/codex" }), "/opt/codex/bin/codex");
  const executable = codexExecutable({});
  if (process.platform === "darwin" && existsSync("/Applications/ChatGPT.app/Contents/Resources/codex")) {
    assert.equal(executable, "/Applications/ChatGPT.app/Contents/Resources/codex");
  } else {
    assert.equal(executable, "codex");
  }
});

function configuredCodex(overrides = {}) {
  const codex = new CodexAppServer({
    cwd: "/tmp",
    onThreadId: async () => {},
    ...overrides,
  });
  codex.effectiveConfig = {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "xhigh",
    service_tier: "priority",
    approval_policy: "on-request",
    approvals_reviewer: "guardian_subagent",
    sandbox_mode: "workspace-write",
  };
  return codex;
}

function inheritedThread(id) {
  return {
    thread: { id },
    cwd: "/tmp",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    reasoningEffort: "xhigh",
    serviceTier: "priority",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: ["/tmp"],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}
