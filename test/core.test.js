import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MANUAL_COMPLETION_REMINDER,
  Bridge,
  IMESSAGE_EDIT_WINDOW_MS,
  PROGRESS_EDIT_LIMIT,
  isPlainTextFinal,
  normalizeMessageStack,
  normalizeMimeType,
  normalizePhone,
  normalizeReaction,
  parseOutboundResponse,
  safeName,
  snapshotFile,
  splitApprovalPrompt,
  splitMessage,
  transportInstructions,
  withCompletionReminder,
} from "../src/bridge.js";
import {
  CONTROL_PREFACE_LIMIT,
  controlRequest,
  controlRequestLimit,
  startControlServer,
} from "../src/control.js";
import {
  CodexAppServer,
  codexAppServerArgs,
  codexEnvironment,
  codexExecutable,
  modelPerformanceDefaults,
} from "../src/codex.js";
import {
  DEFAULT_AUTO_SEND_FINAL,
  DEFAULT_CODEX_OVERRIDES,
  emptyState,
  loadConfig,
  loadState,
  normalizeAutoSendFinal,
  normalizeCodexOverrides,
  normalizeSender,
  normalizeState,
  saveConfig,
  saveState,
} from "../src/config.js";
import { safeErrorRecord } from "../src/errors.js";
import { formatServerRequest, resolveServerRequest, supportsServerRequest } from "../src/interaction.js";
import { logEvent } from "../src/log.js";
import { launchAgentPlist } from "../src/service.js";

const TEST_SENDER = `+${"9".repeat(11)}`;

test("normalizes E.164 input without weakening validation", () => {
  assert.equal(normalizeSender(`+${"9".repeat(3)} (${"9".repeat(3)}) ${"9".repeat(3)}-${"9".repeat(3)}`), `+${"9".repeat(12)}`);
  assert.equal(normalizePhone(`+${"8".repeat(2)} ${"8".repeat(4)} ${"8".repeat(4)}`), `+${"8".repeat(10)}`);
  assert.throws(() => normalizeSender("555-1234"));
});

test("persists the final-delivery setting with transport configuration and the three Codex overrides", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-config-"));
  const env = {
    PHOTON_CODEX_HOME: home,
    PHOTON_CODEX_REASONING_EFFORT: "light",
    PHOTON_CODEX_FAST_MODE: "false",
  };
  try {
    await saveConfig({
      projectId: "project",
      allowedSender: TEST_SENDER,
      cwd: path.join(home, "workspace"),
      autoSendFinal: true,
      codexOverrides: {
        reasoningEffort: "extra high",
        fastMode: false,
        followUpMode: "steer",
      },
    }, env);

    const stored = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    const loaded = await loadConfig(env);
    assert.deepEqual(Object.keys(stored).sort(), ["allowedSender", "autoSendFinal", "codexOverrides", "cwd", "maxAttachmentBytes", "projectId"]);
    assert.equal(stored.autoSendFinal, true);
    assert.equal(loaded.autoSendFinal, true);
    assert.deepEqual(stored.codexOverrides, {
      reasoningEffort: "extra high",
      fastMode: false,
      followUpMode: "steer",
    });
    assert.deepEqual(loaded.codexOverrides, {
      reasoningEffort: "xhigh",
      fastMode: false,
      followUpMode: "steer",
    });
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
      allowedSender: TEST_SENDER,
      cwd: path.join(home, "workspace"),
      reasoningEffort: "extra high",
      fastMode: true,
    }));

    const loaded = await loadConfig(env);
    assert.deepEqual(Object.keys(loaded).sort(), ["allowedSender", "autoSendFinal", "codexOverrides", "cwd", "maxAttachmentBytes", "projectId"]);
    assert.equal(loaded.autoSendFinal, false);
    assert.deepEqual(loaded.codexOverrides, {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reloads the durable follow-up queue in FIFO order", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-queue-state-"));
  const env = { PHOTON_CODEX_HOME: home };
  try {
    const state = emptyState();
    state.messageQueue = [
      { messageId: "message-1", input: [{ type: "text", text: "first" }] },
      { messageId: "message-2", input: [{ type: "text", text: "second" }] },
    ];
    await saveState(state, env);

    const loaded = await loadState(env);

    assert.deepEqual(loaded.messageQueue, state.messageQueue);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("normalizes the complete public override vocabulary and validates the boundary", () => {
  assert.equal(DEFAULT_AUTO_SEND_FINAL, false);
  assert.equal(normalizeAutoSendFinal(), false);
  assert.equal(normalizeAutoSendFinal(false), false);
  assert.equal(normalizeAutoSendFinal(true), true);
  assert.throws(() => normalizeAutoSendFinal("false"), /must be true or false/);
  assert.deepEqual(DEFAULT_CODEX_OVERRIDES, {
    reasoningEffort: "medium",
    fastMode: true,
    followUpMode: "steer",
  });
  assert.deepEqual(normalizeCodexOverrides(), {});
  assert.deepEqual(normalizeCodexOverrides({ reasoningEffort: "light" }), { reasoningEffort: "low" });
  assert.deepEqual(normalizeCodexOverrides({ reasoningEffort: "medium" }), { reasoningEffort: "medium" });
  assert.deepEqual(normalizeCodexOverrides({ reasoningEffort: "high" }), { reasoningEffort: "high" });
  assert.deepEqual(normalizeCodexOverrides({ reasoningEffort: " Extra   High " }), { reasoningEffort: "xhigh" });
  assert.deepEqual(normalizeCodexOverrides({ reasoningEffort: "max", fastMode: true, followUpMode: " Steer " }), {
    reasoningEffort: "max",
    fastMode: true,
    followUpMode: "steer",
  });
  assert.deepEqual(normalizeCodexOverrides({ fastMode: false }), { fastMode: false });
  assert.deepEqual(normalizeCodexOverrides({ followUpMode: "QUEUE" }), { followUpMode: "queue" });
  assert.throws(() => normalizeCodexOverrides({ reasoningEffort: "minimal" }), /light, medium, high, extra high, or max/);
  assert.throws(() => normalizeCodexOverrides({ fastMode: "false" }), /must be true or false/);
  assert.throws(() => normalizeCodexOverrides({ followUpMode: "interrupt" }), /must be queue or steer/);
  assert.throws(() => normalizeCodexOverrides({ followUpMode: false }), /must be queue or steer/);
  assert.throws(() => normalizeCodexOverrides({ model: "gpt-5.6-sol" }), /unsupported field: model/);
  assert.throws(() => normalizeCodexOverrides([]), /must be an object/);
});

test("makes manual final delivery the explicit default transport contract", () => {
  const manual = transportInstructions(false);
  assert.match(manual, /Automatic final delivery is disabled/);
  assert.match(manual, /No final answer, commentary, reasoning summary, tool call, tool output, or reaction directive/);
  assert.match(manual, /end the Codex turn with exactly Answered/);
  assert.match(manual, /Automatic progress-to-final editing is disabled/);

  const automatic = transportInstructions(true);
  assert.match(automatic, /delivers your final answer automatically/);
  assert.match(automatic, /\[\[photon_reaction:EMOJI\]\]/);

  const receipt = { messageId: "synthetic-message" };
  assert.equal(withCompletionReminder(receipt, true), receipt);
  assert.deepEqual(withCompletionReminder(receipt, false), {
    messageId: "synthetic-message",
    autoSendFinal: false,
    completionReminder: MANUAL_COMPLETION_REMINDER,
  });
});

test("uses only app-server process overrides for the three supported settings", () => {
  assert.deepEqual(codexAppServerArgs(), ["app-server", "--listen", "stdio://"]);
  assert.deepEqual(codexAppServerArgs({ reasoningEffort: "xhigh" }), [
    "app-server", "--listen", "stdio://", "--config", "model_reasoning_effort=\"xhigh\"",
  ]);
  assert.deepEqual(codexAppServerArgs({ fastMode: false }), [
    "app-server", "--listen", "stdio://", "--config", "service_tier=\"default\"",
  ]);
  assert.deepEqual(codexAppServerArgs({ reasoningEffort: "max", fastMode: true }), [
    "app-server", "--listen", "stdio://",
    "--config", "model_reasoning_effort=\"max\"",
    "--config", "service_tier=\"fast\"",
  ]);
  assert.deepEqual(codexAppServerArgs({ followUpMode: "steer" }), [
    "app-server", "--listen", "stdio://",
    "--config", "desktop.followUpQueueMode=\"steer\"",
  ]);
  assert.deepEqual(codexAppServerArgs({ reasoningEffort: "medium", fastMode: true, followUpMode: "queue" }), [
    "app-server", "--listen", "stdio://",
    "--config", "model_reasoning_effort=\"medium\"",
    "--config", "service_tier=\"fast\"",
    "--config", "desktop.followUpQueueMode=\"queue\"",
  ]);
  assert.throws(() => codexAppServerArgs({ reasoningEffort: "extra high" }), /Invalid native/);
  assert.throws(() => codexAppServerArgs({ fastMode: 1 }), /Invalid Codex fast mode/);
  assert.throws(() => codexAppServerArgs({ followUpMode: "interrupt" }), /Invalid Codex follow-up mode/);
});

test("never borrows performance defaults from an unrelated catalog model", () => {
  const models = [{
    id: "gpt-default",
    model: "gpt-default",
    isDefault: true,
    defaultReasoningEffort: "low",
    defaultServiceTier: null,
  }];
  assert.deepEqual(modelPerformanceDefaults({ model: null }, models), {
    reasoningEffort: "low",
    serviceTier: "default",
  });
  assert.deepEqual(modelPerformanceDefaults({ model: "gpt-default" }, models), {
    reasoningEffort: "low",
    serviceTier: "default",
  });
  assert.deepEqual(modelPerformanceDefaults({ model: "custom-provider-model" }, models), {
    reasoningEffort: null,
    serviceTier: null,
  });
});

test("sanitizes inbound filenames", () => {
  assert.equal(safeName("../../private file.pdf"), "private file.pdf");
  assert.equal(safeName("../設計資料.pdf"), "設計資料.pdf");
  const longName = safeName(`${"ü".repeat(200)}.pdf`);
  assert.equal(longName.endsWith(".pdf"), true);
  assert.equal(Buffer.byteLength(longName) <= 240, true);
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

test("handles adjacent text and never exposes a malformed private reaction directive", () => {
  assert.deepEqual(parseOutboundResponse("[[photon_reaction:🧐]]Short answer."), {
    reaction: "🧐",
    text: "Short answer.",
  });
  assert.deepEqual(parseOutboundResponse("[[photon_reaction:👍]]\r\nAcknowledged."), {
    reaction: "👍",
    text: "Acknowledged.",
  });
  assert.deepEqual(parseOutboundResponse("[[photon_reaction:👍👍]]\nStill answering."), {
    reaction: null,
    text: "Still answering.",
    reactionError: "reaction must be exactly one emoji",
  });
  assert.deepEqual(parseOutboundResponse("[[photon_reaction:👍\nStill answering."), {
    reaction: null,
    text: "Still answering.",
    reactionError: "reaction directive is incomplete",
  });
});

test("accepts one complete emoji grapheme and a strict MIME type", () => {
  assert.equal(normalizeReaction("👨‍💻"), "👨‍💻");
  assert.equal(normalizeReaction("🇦🇪"), "🇦🇪");
  assert.equal(normalizeReaction("like"), "👍");
  assert.throws(() => normalizeReaction("👍👍"), /exactly one emoji/);
  assert.equal(normalizeMimeType("Application/PDF"), "application/pdf");
  assert.throws(() => normalizeMimeType("application/pdf\r\nX-Test: yes"), /valid MIME type/);
});

test("validates ordered message stacks and conservative plain-text finals", () => {
  const messages = ["found it", "• cause: fixed\n• result: verified", "🔗 https://example.com"];
  assert.deepEqual(normalizeMessageStack(messages), messages);
  assert.equal(isPlainTextFinal("Done. The check passed ✅"), true);
  assert.equal(isPlainTextFinal("**Done.**"), false);
  assert.equal(isPlainTextFinal("_Done._"), false);
  assert.equal(isPlainTextFinal("*Done.*"), false);
  assert.equal(isPlainTextFinal("- first\n- second"), false);
  assert.equal(isPlainTextFinal("[open it](https://example.com)"), false);
  assert.throws(() => normalizeMessageStack(["only one"]), /at least two/);
  assert.throws(() => normalizeMessageStack(["one", "   "]), /must contain text/);
});

test("snapshots and fingerprints an outbound file before Spectrum reads it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-send-file-"));
  const file = path.join(home, "brief.pdf");
  const original = Buffer.from("fixed attachment bytes");
  let built;
  try {
    await writeFile(file, original);
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024 },
      projectSecret: "secret",
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = {
      id: "space-1",
      send: async (builder) => {
        built = await builder.build();
        return {
          id: "sent-file-1",
          isSent: true,
          attachmentMetadata: [{ mimeType: "application/pdf", totalBytes: original.byteLength, transferState: "finished" }],
        };
      },
    };

    const snapshot = await snapshotFile(file, 1024);
    await writeFile(file, "mutated after validation");
    const receipt = await bridge.sendFile({
      data: snapshot.bytes.toString("base64"),
      size: snapshot.size,
      sha256: snapshot.sha256,
      name: snapshot.name,
      mimeType: "application/pdf",
    });

    assert.equal((await built.read()).compare(original), 0);
    assert.deepEqual(receipt, {
      providerAccepted: true,
      messageId: "sent-file-1",
      name: "brief.pdf",
      requestedMimeType: "application/pdf",
      providerMimeType: "application/pdf",
      size: original.byteLength,
      providerSize: original.byteLength,
      sha256: "e0887f3b0291ef2f856a3f4fe74b545c205d609cd16fecea76c186e197c28a5e",
      isSent: true,
      isDelivered: null,
      transferState: "finished",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fails outbound files closed on size and missing provider receipts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-send-file-fail-"));
  let sends = 0;
  try {
    const file = path.join(home, "too-large.bin");
    await writeFile(file, "12345");
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 4 },
      projectSecret: "secret",
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = { id: "space-1", send: async () => { sends += 1; return undefined; } };

    await assert.rejects(() => snapshotFile(file, 4), /exceeds 4 bytes/);
    const snapshot = await snapshotFile(file, 1024);
    await assert.rejects(() => bridge.sendFile({
      data: snapshot.bytes.toString("base64"),
      size: snapshot.size,
      sha256: snapshot.sha256,
      name: snapshot.name,
    }), /exceeds 4 bytes/);
    assert.equal(sends, 0);
    bridge.config.maxAttachmentBytes = 1024;
    await assert.rejects(() => bridge.sendFile({
      data: snapshot.bytes.toString("base64"),
      size: snapshot.size,
      sha256: snapshot.sha256,
      name: snapshot.name,
    }), /did not return.*message receipt/);
    assert.equal(sends, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("keeps path reads in the caller and validates the loopback byte envelope", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-send-file-scope-"));
  try {
    const boundary = path.join(home, "boundary.txt");
    await writeFile(boundary, "1234");
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 4 },
      projectSecret: "secret",
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = { id: "space-1", send: async () => ({ id: "boundary-message" }) };
    const snapshot = await snapshotFile(boundary, 4);

    assert.equal((await bridge.sendFile({
      data: snapshot.bytes.toString("base64"),
      size: snapshot.size,
      sha256: snapshot.sha256,
      name: snapshot.name,
    })).size, 4);
    await assert.rejects(() => bridge.sendFile({ file: boundary }), /encoded attachment data is required/);
    await assert.rejects(() => bridge.sendFile({
      data: snapshot.bytes.toString("base64"),
      size: snapshot.size,
      sha256: "0".repeat(64),
      name: snapshot.name,
    }), /SHA-256 does not match/);
    await assert.rejects(() => bridge.sendFile({
      data: "!!!!",
      size: 3,
      sha256: snapshot.sha256,
      name: snapshot.name,
    }), /canonical base64/);
    await assert.rejects(() => bridge.sendFile({
      data: snapshot.bytes.toString("base64"),
      size: 3,
      sha256: snapshot.sha256,
      name: snapshot.name,
    }), /size does not match/);
    await assert.rejects(() => snapshotFile(home, 4), /not a regular file/);
    assert.equal(controlRequestLimit(4), 16_392);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("authenticates the bounded control preface before accepting a framed attachment body", async () => {
  const token = "test-control-token";
  const received = [];
  const server = await startControlServer({
    token,
    maxAttachmentBytes: 4,
    idleTimeoutMs: 40,
    maxConnections: 4,
    handle: async (request) => {
      received.push(request);
      return { accepted: request.command === "send-file", size: request.size };
    },
  });
  const port = server.address().port;
  let held;
  let boundServer;
  try {
    const unauthorized = await rawControl(port, `${JSON.stringify({ token: "wrong", command: "status", bodyBytes: 2 })}\n`);
    assert.match(unauthorized, /unauthorized/);
    assert.equal(received.length, 0);

    const oversized = await rawControl(port, `${JSON.stringify({ token, command: "send-file", bodyBytes: controlRequestLimit(4) + 1 })}\n`);
    assert.match(oversized, /exceeds the command limit/);
    assert.equal(received.length, 0);

    const malformed = await rawControl(port, "not-json\n");
    assert.match(malformed, /preface is malformed/);
    const longPreface = await rawControl(port, "x".repeat(CONTROL_PREFACE_LIMIT + 1));
    assert.match(longPreface, /preface is too large/);
    const earlyBody = await rawControl(port, `${JSON.stringify({ token, command: "status", bodyBytes: 2 })}\n{}`);
    assert.match(earlyBody, /before authentication/);
    const malformedBody = await framedControl(port, token, "status", Buffer.from("xx"));
    assert.match(malformedBody, /body is malformed/);
    const overlongBody = await framedControl(port, token, "status", Buffer.from("{}x"), 2);
    assert.match(overlongBody, /exceeds declared length/);

    const stalled = await rawControl(port, "");
    assert.match(stalled, /connection timed out/);

    const attachment = {
      data: Buffer.from("test").toString("base64"),
      size: 4,
      sha256: "0".repeat(64),
      mimeType: "application/octet-stream",
      name: "test.bin",
    };
    assert.deepEqual(await controlRequest({ port, token, command: "send-file", body: attachment }), {
      accepted: true,
      size: 4,
    });
    assert.deepEqual(received, [{ command: "send-file", ...attachment }]);

    boundServer = await startControlServer({
      token,
      maxAttachmentBytes: 4,
      idleTimeoutMs: 1000,
      maxConnections: 1,
      handle: async () => ({}),
    });
    held = net.createConnection({ host: "127.0.0.1", port: boundServer.address().port });
    await new Promise((resolve, reject) => {
      held.once("connect", resolve);
      held.once("error", reject);
    });
    const bounded = await rawControl(boundServer.address().port, `${JSON.stringify({ token, command: "status", bodyBytes: 2 })}\n`);
    assert.match(bounded, /connection limit reached/);
  } finally {
    held?.destroy();
    boundServer?.destroyControlConnections();
    if (boundServer) await new Promise((resolve) => boundServer.close(resolve));
    server.destroyControlConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("carries edit, progress, and message-stack commands through the bounded control protocol", async () => {
  const token = "test-message-control-token";
  const received = [];
  const server = await startControlServer({
    token,
    maxAttachmentBytes: 4,
    handle: async (request) => {
      received.push(request);
      return { command: request.command };
    },
  });
  const port = server.address().port;
  try {
    assert.deepEqual(await controlRequest({ port, token, command: "progress", body: { text: "checking" } }), {
      command: "progress",
    });
    assert.deepEqual(await controlRequest({
      port,
      token,
      command: "edit",
      body: { messageId: "outbound-1", text: "still checking" },
    }), { command: "edit" });
    assert.deepEqual(await controlRequest({
      port,
      token,
      command: "send-stack",
      body: { messages: ["one", "two\nlines", "😀"] },
    }), { command: "send-stack" });
    assert.deepEqual(received.map(({ command }) => command), ["progress", "edit", "send-stack"]);
  } finally {
    server.destroyControlConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("persists only allowlisted content-free log and last-error fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-safe-log-"));
  const env = { PHOTON_CODEX_HOME: home };
  const hostile = {
    credential: ["credential", "material"].join("-"),
    phone: `+${"7".repeat(12)}`,
    id: ["private", "identifier", "value"].join("-"),
    path: ["", "Users", "person", "private", "workspace"].join("/"),
    command: ["print", "private", "command"].join(" "),
    diff: ["+private", "-content"].join("\n"),
    message: ["private", "message", "body"].join(" "),
  };
  const error = new Error(Object.values(hostile).join(" | "));
  const safe = safeErrorRecord("message_failed", error);
  try {
    await logEvent("error", "message_failed", {
      contentType: "text",
      errorCategory: safe.category,
      errorCode: safe.code,
      ...hostile,
    }, env);
    await logEvent("error", hostile.message, hostile, env);
    await logEvent("warn", "message_edit_failed", {
      phase: "control",
      errorCategory: "photon",
      errorCode: "provider_rejected",
      ...hostile,
    }, env);
    await logEvent("warn", "stack_send_failed", {
      count: 3,
      failedIndex: 1,
      sentCount: 1,
      errorCategory: "photon",
      errorCode: "provider_rejected",
      ...hostile,
    }, env);

    const state = emptyState();
    state.runtime.lastError = { ...safe, detail: Object.values(hostile).join(" | ") };
    await saveState(state, env);
    const storedLog = await readFile(path.join(home, "runtime.log"), "utf8");
    const storedState = await readFile(path.join(home, "state.json"), "utf8");
    for (const value of Object.values(hostile)) {
      assert.equal(storedLog.includes(value), false);
      assert.equal(storedState.includes(value), false);
    }
    const entries = storedLog.trim().split("\n").map(JSON.parse);
    assert.deepEqual(Object.keys(entries[0]).sort(), ["contentType", "errorCategory", "errorCode", "event", "level", "time"]);
    assert.equal(entries[1].event, "log_event_rejected");
    assert.deepEqual(Object.keys(entries[2]).sort(), ["errorCategory", "errorCode", "event", "level", "phase", "time"]);
    assert.deepEqual(Object.keys(entries[3]).sort(), ["count", "errorCategory", "errorCode", "event", "failedIndex", "level", "sentCount", "time"]);
    assert.deepEqual((await loadState(env)).runtime.lastError, safe);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("normalizes aliases and requires a provider receipt for direct reactions", async () => {
  const seen = [];
  const bridge = new Bridge({
    config: { projectId: "project", allowedSender: TEST_SENDER, cwd: "/tmp", maxAttachmentBytes: 1024 },
    projectSecret: "secret",
    logger: async () => {},
  });
  bridge.state = { ...emptyState(), spaceId: "space-1" };
  bridge.space = {
    getMessage: async () => ({ id: "message-1", react: async (emoji) => { seen.push(emoji); return { id: "reaction-1", isSent: false }; } }),
  };

  assert.deepEqual(await bridge.reactToMessage({ messageId: "message-1", emoji: "like" }), {
    providerAccepted: true,
    targetMessageId: "message-1",
    receiptId: "reaction-1",
    emoji: "👍",
  });
  assert.deepEqual(seen, ["👍"]);
  bridge.space.getMessage = async () => ({ react: async () => undefined });
  await assert.rejects(
    () => bridge.reactToMessage({ messageId: "message-1", emoji: "👍" }),
    /did not return.*reaction.*receipt/,
  );
});

test("tracks one active progress bubble, reserves edit five, and edits a plain final in place", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-progress-"));
  const edits = [];
  const replies = [];
  const events = [];
  try {
    const sent = {
      id: "progress-1",
      direction: "outbound",
      timestamp: new Date(),
      content: { type: "text", text: "Checking the bridge" },
      edit: async (builder) => { edits.push(await builder.build()); },
    };
    const space = {
      id: "space-1",
      send: async () => sent,
      stopTyping: async () => {},
    };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async (level, event, details) => events.push({ level, event, details }),
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "turn-1";
    bridge.targetByTurn.set("turn-1", {
      id: "inbound-1",
      reply: async (content) => { replies.push(await content.build()); },
      space,
    });

    const progress = await bridge.sendProgress({ text: "Checking the bridge" });
    assert.equal(progress.messageId, "progress-1");
    assert.equal(progress.remainingProgressEdits, PROGRESS_EDIT_LIMIT);
    assert.equal(progress.finalEditReserved, true);

    let receipt;
    for (let index = 1; index <= PROGRESS_EDIT_LIMIT; index += 1) {
      receipt = await bridge.editMessage({ messageId: "progress-1", text: `Progress ${index}` });
      assert.equal(receipt.observedEdits, index);
      assert.equal(receipt.remainingProgressEdits, PROGRESS_EDIT_LIMIT - index);
    }
    assert.match(receipt.warning, /fifth.*reserved/i);
    await assert.rejects(
      () => bridge.editMessage({ messageId: "progress-1", text: "Do not spend edit five" }),
      /fifth iMessage edit is reserved/,
    );

    bridge.finalByTurn.set("turn-1", "Finished cleanly ✅");
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    assert.equal(edits.length, 5);
    assert.deepEqual(edits.at(-1), { type: "text", text: "Finished cleanly ✅" });
    assert.equal(replies.length, 0);
    assert.equal(bridge.deliveryByTurn.size, 0);
    assert.deepEqual(bridge.state.repliedMessageIds, ["inbound-1"]);
    assert.equal(events.filter(({ event }) => event === "message_edited").at(-1).details.phase, "final_answer");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("manual mode permits an explicit fifth edit and suppresses every automatic final output", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-manual-final-"));
  const edits = [];
  const replies = [];
  const reactions = [];
  const events = [];
  try {
    const progressMessage = {
      id: "manual-progress",
      direction: "outbound",
      timestamp: new Date(),
      content: { type: "text", text: "Starting" },
      edit: async (builder) => { edits.push(await builder.build()); },
    };
    const space = {
      id: "space-1",
      send: async () => progressMessage,
      stopTyping: async () => {},
    };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: false },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async (level, event, details) => events.push({ level, event, details }),
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "manual-turn";
    bridge.targetByTurn.set("manual-turn", {
      id: "manual-inbound",
      react: async (emoji) => { reactions.push(emoji); return { id: "reaction" }; },
      reply: async (content) => { replies.push(await content.build()); return { id: "reply" }; },
      space,
    });

    await bridge.sendProgress({ text: "Starting" });
    let receipt;
    for (let index = 1; index <= 5; index += 1) {
      receipt = await bridge.editMessage({ messageId: "manual-progress", text: `Manual ${index}` });
    }
    assert.equal(receipt.observedEdits, 5);
    assert.equal(receipt.remainingProgressEdits, 0);
    assert.equal(receipt.finalEditReserved, false);
    assert.match(receipt.warning, /fifth and final edit/);
    await assert.rejects(
      () => bridge.editMessage({ messageId: "manual-progress", text: "Too late" }),
      /fifth and final iMessage edit is already used/,
    );

    for (const phase of ["commentary", "final_answer"]) {
      await bridge.handleCodexNotification("item/completed", {
        turnId: "manual-turn",
        item: { type: "agentMessage", phase, text: "[[photon_reaction:🫡]] hidden output" },
      });
    }
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "manual-turn", status: "completed", items: [{ type: "agentMessage", text: "hidden fallback" }] },
    });

    assert.equal(edits.length, 5);
    assert.deepEqual(replies, []);
    assert.deepEqual(reactions, []);
    assert.deepEqual(bridge.state.repliedMessageIds, []);
    assert.equal(bridge.deliveryByTurn.size, 0);
    assert.equal(events.filter(({ event }) => event === "final_suppressed").length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("edits an earlier outbound text message directly and rejects inbound or expired targets", async () => {
  const edited = [];
  const messages = new Map();
  const current = {
    id: "outbound-current",
    direction: "outbound",
    timestamp: new Date(),
    content: { type: "text", text: "draft" },
    edit: async (builder) => { edited.push(await builder.build()); },
  };
  messages.set(current.id, current);
  messages.set("inbound", {
    id: "inbound",
    direction: "inbound",
    timestamp: new Date(),
    content: { type: "text", text: "user text" },
    edit: async () => { throw new Error("should not run"); },
  });
  messages.set("expired", {
    id: "expired",
    direction: "outbound",
    timestamp: new Date(Date.now() - IMESSAGE_EDIT_WINDOW_MS),
    content: { type: "text", text: "old" },
    edit: async () => { throw new Error("should not run"); },
  });
  const bridge = new Bridge({
    config: { projectId: "project", allowedSender: TEST_SENDER, cwd: "/tmp", maxAttachmentBytes: 1024 },
    projectSecret: "secret",
    logger: async () => {},
  });
  bridge.state = { ...emptyState(), spaceId: "space-1" };
  bridge.space = { getMessage: async (id) => messages.get(id) };

  const result = await bridge.editMessage({ messageId: current.id, text: "final" });
  assert.equal(result.edited, true);
  assert.equal(result.observedEdits, null);
  assert.match(result.warning, /Earlier edits.*not observable/);
  assert.deepEqual(edited, [{ type: "text", text: "final" }]);
  await assert.rejects(() => bridge.editMessage({ messageId: "inbound", text: "no" }), /only outbound/);
  await assert.rejects(() => bridge.editMessage({ messageId: "expired", text: "late" }), /15-minute.*expired/);
});

test("falls back to the normal final path when a progress edit fails", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-progress-fallback-"));
  const replies = [];
  const events = [];
  try {
    const sent = {
      id: "progress-failure",
      direction: "outbound",
      timestamp: new Date(),
      content: { type: "text", text: "Checking" },
      edit: async () => { throw new Error("provider rejected edit"); },
    };
    const space = { id: "space-1", send: async () => sent, stopTyping: async () => {} };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async (level, event, details) => events.push({ level, event, details }),
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "turn-failure";
    bridge.targetByTurn.set("turn-failure", {
      id: "inbound-failure",
      reply: async (content) => { replies.push(await content.build()); return { id: "reply-1" }; },
      space,
    });
    await bridge.sendProgress({ text: "Checking" });
    bridge.finalByTurn.set("turn-failure", "The complete answer still arrives.");

    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-failure", status: "completed", items: [] },
    });

    assert.deepEqual(replies, [{ type: "markdown", markdown: "The complete answer still arrives." }]);
    assert.equal(events.some(({ event }) => event === "message_edit_failed"), true);
    assert.deepEqual(bridge.state.repliedMessageIds, ["inbound-failure"]);
    assert.equal(bridge.deliveryByTurn.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rich, file-bearing, and expired progress finals bypass editing", async (t) => {
  const cases = [
    { name: "rich", final: "**Finished.**", configure: () => {} },
    { name: "long", final: "a".repeat(4001), configure: () => {} },
    { name: "file", final: "Finished.", configure: (bridge) => { bridge.deliveryByTurn.get("turn-1").hadFile = true; } },
    { name: "expired", final: "Finished.", configure: (bridge, sent) => { sent.timestamp = new Date(Date.now() - IMESSAGE_EDIT_WINDOW_MS); } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), `photon-codex-progress-${scenario.name}-`));
      const replies = [];
      let edits = 0;
      try {
        const sent = {
          id: `progress-${scenario.name}`,
          direction: "outbound",
          timestamp: new Date(),
          content: { type: "text", text: "Checking" },
          edit: async () => { edits += 1; },
        };
        const space = { id: "space-1", send: async () => sent, stopTyping: async () => {} };
        const bridge = new Bridge({
          config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
          projectSecret: "secret",
          env: { ...process.env, PHOTON_CODEX_HOME: home },
          logger: async () => {},
        });
        bridge.state = { ...emptyState(), spaceId: "space-1" };
        bridge.space = space;
        bridge.activeTurnId = "turn-1";
        bridge.targetByTurn.set("turn-1", {
          id: `inbound-${scenario.name}`,
          reply: async (content) => { replies.push(await content.build()); return { id: "reply-1" }; },
          space,
        });
        await bridge.sendProgress({ text: "Checking" });
        scenario.configure(bridge, sent);
        bridge.finalByTurn.set("turn-1", scenario.final);
        await bridge.handleCodexNotification("turn/completed", {
          turn: { id: "turn-1", status: "completed", items: [] },
        });
        assert.equal(edits, 0);
        assert.equal(replies.length, 1);
        assert.equal(bridge.deliveryByTurn.size, 0);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("turn failure clears progress state and sends the existing failure reply", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-progress-turn-failure-"));
  const replies = [];
  try {
    const sent = {
      id: "progress-turn-failure",
      direction: "outbound",
      timestamp: new Date(),
      content: { type: "text", text: "Checking" },
      edit: async () => {},
    };
    const space = { id: "space-1", send: async () => sent, stopTyping: async () => {} };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024 },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "turn-failed";
    bridge.targetByTurn.set("turn-failed", {
      id: "inbound-failed",
      reply: async (content) => { replies.push(content); return { id: "failure-reply" }; },
      space,
    });
    await bridge.sendProgress({ text: "Checking" });

    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-failed", status: "failed", items: [] },
    });

    assert.deepEqual(replies, ["I could not finish that Codex turn. Please try again."]);
    assert.equal(bridge.deliveryByTurn.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("sends a complete Unicode stack in order and marks the active turn delivered", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-stack-"));
  const built = [];
  const replies = [];
  try {
    const space = {
      id: "space-1",
      send: async (builder) => {
        const content = await builder.build();
        built.push(content);
        return { id: `stack-${built.length}`, direction: "outbound", timestamp: new Date(), content };
      },
      stopTyping: async () => {},
    };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "turn-stack";
    bridge.targetByTurn.set("turn-stack", {
      id: "inbound-stack",
      reply: async (content) => { replies.push(await content.build()); },
      space,
    });
    const messages = ["found it", "• cause: Unicode ✅\n• fix: ordered", "🔗 https://example.com"];

    const result = await bridge.sendStack({ messages });
    assert.equal(result.complete, true);
    assert.deepEqual(result.messages.map(({ messageId }) => messageId), ["stack-1", "stack-2", "stack-3"]);
    assert.deepEqual(built.map(({ markdown: value }) => value), messages);

    bridge.finalByTurn.set("turn-stack", "This internal final must not duplicate the complete stack.");
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-stack", status: "completed", items: [] },
    });
    assert.equal(replies.length, 0);
    assert.deepEqual(bridge.state.repliedMessageIds, ["inbound-stack"]);
    assert.equal(bridge.deliveryByTurn.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a complete stack remains the delivered answer when Codex emits no final text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-stack-no-final-"));
  const replies = [];
  try {
    let sent = 0;
    const space = {
      id: "space-1",
      send: async (builder) => {
        const content = await builder.build();
        sent += 1;
        return { id: `stack-${sent}`, direction: "outbound", timestamp: new Date(), content };
      },
      stopTyping: async () => {},
    };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "turn-stack";
    bridge.targetByTurn.set("turn-stack", {
      id: "inbound-stack",
      reply: async (content) => { replies.push(content); },
      space,
    });

    await bridge.sendStack({ messages: ["complete one", "complete two"] });
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-stack", status: "completed", items: [] },
    });

    assert.equal(replies.length, 0);
    assert.deepEqual(bridge.state.repliedMessageIds, ["inbound-stack"]);
    assert.equal(bridge.deliveryByTurn.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reports stack partial delivery exactly and never retries a sent bubble", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-stack-partial-"));
  const attempts = [];
  const replies = [];
  try {
    const space = {
      id: "space-1",
      send: async (builder) => {
        const content = await builder.build();
        attempts.push(content.markdown);
        if (attempts.length === 2) throw new Error("provider rejected second bubble");
        return { id: "stack-first", direction: "outbound", timestamp: new Date(), content };
      },
      stopTyping: async () => {},
    };
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = space;
    bridge.activeTurnId = "turn-partial";
    bridge.targetByTurn.set("turn-partial", {
      id: "inbound-partial",
      reply: async (content) => { replies.push(await content.build()); return { id: "reply-final" }; },
      space,
    });

    const result = await bridge.sendStack({ messages: ["one", "two", "three"] });
    assert.deepEqual(attempts, ["one", "two"]);
    assert.equal(result.complete, false);
    assert.equal(result.partial, true);
    assert.equal(result.sentCount, 1);
    assert.equal(result.firstUnsentIndex, 1);
    assert.deepEqual(result.messages, [
      { index: 0, sent: true, messageId: "stack-first" },
      { index: 1, sent: false, error: { category: "photon", code: "provider_rejected" } },
      { index: 2, sent: false, notAttempted: true },
    ]);

    bridge.finalByTurn.set("turn-partial", "two\n\nthree");
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-partial", status: "completed", items: [] },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].markdown, "two\n\nthree");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ignores Photon read receipts before starting a Codex turn", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-receipt-"));
  try {
    let turnsStarted = 0;
    const bridge = new Bridge({
      config: {
        projectId: "project",
        allowedSender: TEST_SENDER,
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
      sender: { id: TEST_SENDER },
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
        allowedSender: TEST_SENDER,
        cwd: home,
        maxAttachmentBytes: 1024,
        autoSendFinal: true,
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
      sender: { id: TEST_SENDER },
      timestamp: new Date("2026-08-19T00:00:00.000Z"),
      content: { type: "text", text: "hello" },
      read: async () => {},
      react: async (emoji) => { reactions.push(emoji); return { id: "reaction-1" }; },
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

test("a failed reaction never suppresses the answer text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-reaction-failure-"));
  const events = [];
  const replies = [];
  let attempts = 0;
  try {
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async (level, event) => events.push({ level, event }),
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = { stopTyping: async () => {} };
    bridge.activeTurnId = "turn-1";
    bridge.finalByTurn.set("turn-1", "[[photon_reaction:🧐]]Answer still arrives.");
    bridge.targetByTurn.set("turn-1", {
      id: "message-1",
      react: async () => { attempts += 1; throw new Error("reaction unavailable"); },
      reply: async (content) => { replies.push(await content.build()); return { id: "reply-1" }; },
      space: { send: async () => ({ id: "reply-part" }) },
    });

    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    assert.equal(replies[0].markdown, "Answer still arrives.");
    assert.equal(attempts, 1);
    assert.equal(events.some(({ event }) => event === "reaction_failed"), true);
    assert.deepEqual(bridge.state.repliedMessageIds, ["message-1"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a commentary reaction is sent once before the final answer", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-early-reaction-"));
  const reactions = [];
  const replies = [];
  try {
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = { stopTyping: async () => {} };
    bridge.activeTurnId = "turn-1";
    bridge.targetByTurn.set("turn-1", {
      id: "message-1",
      react: async (emoji) => { reactions.push(emoji); return { id: "reaction-1" }; },
      reply: async (content) => { replies.push(await content.build()); return { id: "reply-1" }; },
      space: { send: async () => ({ id: "reply-part" }) },
    });

    await bridge.handleCodexNotification("item/completed", {
      turnId: "turn-1",
      item: { type: "agentMessage", phase: "commentary", text: "[[photon_reaction:🫡️]]" },
    });
    assert.deepEqual(reactions, ["🫡️"]);
    assert.equal(replies.length, 0);

    await bridge.handleCodexNotification("item/completed", {
      turnId: "turn-1",
      item: { type: "agentMessage", phase: "final_answer", text: "Finished." },
    });
    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    assert.deepEqual(reactions, ["🫡️"]);
    assert.equal(replies[0].markdown, "Finished.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed reaction-only response falls back to visible emoji text", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-reaction-fallback-"));
  let fallback;
  try {
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024, autoSendFinal: true },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.space = { stopTyping: async () => {} };
    bridge.activeTurnId = "turn-1";
    bridge.finalByTurn.set("turn-1", "[[photon_reaction:🥦]]");
    bridge.targetByTurn.set("turn-1", {
      id: "message-1",
      react: async () => undefined,
      reply: async (content) => { fallback = await content.build(); return { id: "reply-1" }; },
      space: { send: async () => ({ id: "reply-part" }) },
    });

    await bridge.handleCodexNotification("turn/completed", {
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    assert.equal(fallback.type, "text");
    assert.equal(fallback.text, "🥦");
    assert.deepEqual(bridge.state.repliedMessageIds, ["message-1"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("accepts and unwraps a threaded iMessage reply", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-threaded-reply-"));
  try {
    const inputs = [];
    const bridge = new Bridge({
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024 },
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
      sender: { id: TEST_SENDER },
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
      config: { projectId: "project", allowedSender: TEST_SENDER, cwd: home, maxAttachmentBytes: 1024 },
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
      sender: { id: TEST_SENDER },
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
        allowedSender: TEST_SENDER,
        cwd: home,
        maxAttachmentBytes: 1024,
      },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.activeTurnId = "turn-active";
    bridge.deliveryByTurn.set("turn-active", {
      progress: { message: { id: "old-progress" }, text: "old", editCount: 0 },
      hadFile: false,
      stackAttempted: false,
      stackDelivered: false,
    });
    bridge.codex = {
      followUpMode: () => "queue",
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
      sender: { id: TEST_SENDER },
      timestamp: new Date("2026-08-19T00:00:00.000Z"),
      content: { type: "text", text: "next request" },
      read: async () => {},
      space,
    };

    await bridge.handleMessage(space, message);

    assert.equal(steered, 0);
    assert.equal(bridge.messageQueue.length, 1);
    assert.equal(bridge.messageQueue[0].input[0].text, "next request");
    assert.equal(bridge.deliveryByTurn.has("turn-active"), false);
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

test("steers an active Codex turn when the effective follow-up mode is steer", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "photon-codex-steer-"));
  try {
    const steered = [];
    const bridge = new Bridge({
      config: {
        projectId: "project",
        allowedSender: TEST_SENDER,
        cwd: home,
        maxAttachmentBytes: 1024,
      },
      projectSecret: "secret",
      env: { ...process.env, PHOTON_CODEX_HOME: home },
      logger: async () => {},
    });
    bridge.state = { ...emptyState(), spaceId: "space-1" };
    bridge.activeTurnId = "turn-active";
    bridge.deliveryByTurn.set("turn-active", {
      progress: { message: { id: "old-progress" }, text: "old", editCount: 0 },
      hadFile: false,
      stackAttempted: false,
      stackDelivered: false,
    });
    bridge.codex = {
      followUpMode: () => "steer",
      steer: async (turnId, input) => { steered.push({ turnId, input }); },
    };
    const space = {
      id: "space-1",
      type: "dm",
      startTyping: async () => {},
      stopTyping: async () => {},
    };
    const message = {
      id: "message-steered",
      direction: "inbound",
      sender: { id: TEST_SENDER },
      timestamp: new Date("2026-08-19T00:00:00.000Z"),
      content: { type: "text", text: "adjust the active turn" },
      read: async () => {},
      space,
    };

    await bridge.handleMessage(space, message);

    assert.equal(steered.length, 1);
    assert.equal(steered[0].turnId, "turn-active");
    assert.equal(steered[0].input[0].text, "adjust the active turn");
    assert.equal(bridge.deliveryByTurn.has("turn-active"), false);
    assert.deepEqual(bridge.state.acceptedMessageIds, ["message-steered"]);
    assert.deepEqual(bridge.state.messageQueue, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status reports native Codex config parity without Photon overrides", () => {
  const bridge = new Bridge({
    config: {
      projectId: "project",
      allowedSender: TEST_SENDER,
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
  assert.equal(status.autoSendFinal, false);
  assert.equal(status.finalDelivery, "manual");
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

test("starts a thread with only cwd and app-server-resolved performance values", async () => {
  const codex = configuredCodex({ transportInstructions: "transport only" });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") return inheritedThread("thread-new");
    return {};
  };

  await codex.newThread();

  assert.deepEqual(requests.map(({ method }) => method), ["thread/start", "thread/inject_items"]);
  assert.deepEqual(requests[0].params, {
    cwd: "/tmp",
    serviceTier: "priority",
    config: { model_reasoning_effort: "xhigh" },
  });
  assert.equal(requests[1].params.items[0].role, "developer");
  assert.equal(requests[1].params.items[0].content[0].text, "transport only");
  assert.equal(codex.parityReport().verified, true);
  assert.deepEqual(codex.parityReport().overrides, []);
});

test("fresh threads materialize native model defaults for strict verification", async () => {
  const codex = configuredCodex();
  codex.effectiveConfig.model_reasoning_effort = null;
  codex.effectiveConfig.service_tier = null;
  codex.modelPerformanceDefaults = { reasoningEffort: "low", serviceTier: "default" };
  let params;
  codex.request = async (method, requestParams) => {
    params = requestParams;
    return {
      ...inheritedThread("thread-defaults"),
      reasoningEffort: "low",
      serviceTier: "default",
    };
  };

  await codex.newThread();

  assert.deepEqual(params, {
    cwd: "/tmp",
    serviceTier: "default",
    config: { model_reasoning_effort: "low" },
  });
  assert.equal(codex.parityReport().performance.reasoningEffort.source, "native");
  assert.equal(codex.parityReport().effectiveVerified, true);
});

test("reports partial and combined overrides as verified effective values", async () => {
  const partial = configuredCodex({ codexOverrides: { reasoningEffort: "xhigh" } });
  partial.request = async (method) => method === "thread/start" ? inheritedThread("thread-partial") : {};
  await partial.newThread();

  const partialParity = partial.parityReport();
  assert.equal(partialParity.inherited, true);
  assert.equal(partialParity.effectiveVerified, true);
  assert.deepEqual(partialParity.overrides, ["reasoningEffort"]);
  assert.deepEqual(partialParity.performance.reasoningEffort, {
    source: "override",
    configured: "extra high",
    effective: "xhigh",
    thread: "xhigh",
    verified: true,
  });
  assert.equal(partialParity.performance.fastMode.source, "native");

  const combined = configuredCodex({ codexOverrides: { reasoningEffort: "xhigh", fastMode: true } });
  combined.request = async (method) => method === "thread/start" ? inheritedThread("thread-combined") : {};
  await combined.newThread();
  const combinedParity = combined.parityReport();
  assert.deepEqual(combinedParity.overrides, ["reasoningEffort", "fastMode"]);
  assert.deepEqual(combinedParity.performance.fastMode, {
    source: "override",
    configured: true,
    effective: true,
    serviceTier: "priority",
    threadServiceTier: "priority",
    verified: true,
  });
  assert.equal(combinedParity.effectiveVerified, true);
});

test("fastMode false explicitly verifies the default service tier", async () => {
  const codex = configuredCodex({ codexOverrides: { fastMode: false } });
  codex.effectiveConfig.service_tier = "default";
  codex.request = async (method) => method === "thread/start"
    ? { ...inheritedThread("thread-default"), serviceTier: "default" }
    : {};

  await codex.newThread();

  assert.deepEqual(codex.parityReport().performance.fastMode, {
    source: "override",
    configured: false,
    effective: false,
    serviceTier: "default",
    threadServiceTier: "default",
    verified: true,
  });
  assert.equal(codex.parityReport().effectiveVerified, true);
});

test("reports inherited, defaulted, and overridden follow-up modes truthfully", async () => {
  const defaulted = configuredCodex();
  defaulted.request = async () => inheritedThread("thread-default-steer");
  await defaulted.newThread();
  assert.deepEqual(defaulted.parityReport().followUpMode, {
    source: "native",
    configured: null,
    effective: "steer",
    configValue: null,
    verified: true,
  });
  assert.equal(defaulted.followUpMode(), "steer");

  const inherited = configuredCodex();
  inherited.effectiveConfig.desktop = { followUpQueueMode: "queue" };
  inherited.request = async () => inheritedThread("thread-native-queue");
  await inherited.newThread();
  assert.deepEqual(inherited.parityReport().followUpMode, {
    source: "native",
    configured: null,
    effective: "queue",
    configValue: "queue",
    verified: true,
  });
  assert.equal(inherited.followUpMode(), "queue");

  const legacy = configuredCodex();
  legacy.effectiveConfig.desktop = { followUpQueueMode: "interrupt" };
  legacy.request = async () => inheritedThread("thread-native-interrupt");
  await legacy.newThread();
  assert.deepEqual(legacy.parityReport().followUpMode, {
    source: "native",
    configured: null,
    effective: "steer",
    configValue: "interrupt",
    verified: true,
  });

  const overridden = configuredCodex({ codexOverrides: { followUpMode: "steer" } });
  overridden.effectiveConfig.desktop = { followUpQueueMode: "steer" };
  overridden.request = async () => inheritedThread("thread-override-steer");
  await overridden.newThread();
  assert.deepEqual(overridden.parityReport().overrides, ["followUpMode"]);
  assert.deepEqual(overridden.parityReport().followUpMode, {
    source: "override",
    configured: "steer",
    effective: "steer",
    configValue: "steer",
    verified: true,
  });
});

test("fails parity when app-server does not apply a follow-up mode override", async () => {
  const codex = configuredCodex({ codexOverrides: { followUpMode: "steer" } });
  codex.effectiveConfig.desktop = { followUpQueueMode: "queue" };
  codex.request = async () => inheritedThread("thread-follow-up-mismatch");

  await assert.rejects(() => codex.newThread(), /followUpMode unverified/);
  assert.equal(codex.parityReport().effectiveVerified, false);
  assert.equal(codex.parityReport().followUpMode.verified, false);
});

test("fails parity closed for an unsupported inherited follow-up mode", async () => {
  const codex = configuredCodex();
  codex.effectiveConfig.desktop = { followUpQueueMode: "future-mode" };
  codex.request = async () => inheritedThread("thread-unsupported-follow-up");

  await assert.rejects(() => codex.newThread(), /followUpMode unverified/);
  assert.equal(codex.followUpMode(), null);
  assert.equal(codex.parityReport().followUpMode.verified, false);
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

test("resumes persisted threads with app-server-resolved native performance values", async () => {
  const codex = configuredCodex({ threadId: "thread-1" });
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return inheritedThread("thread-1");
  };

  await codex.ensureThread();

  assert.equal(request.method, "thread/resume");
  assert.deepEqual(request.params, {
    threadId: "thread-1",
    cwd: "/tmp",
    serviceTier: "priority",
    config: { model_reasoning_effort: "xhigh" },
  });
  assert.equal(codex.parityReport().verified, true);
});

test("reinjects the current transport contract when a persisted thread resumes", async () => {
  const codex = configuredCodex({
    threadId: "thread-1",
    transportInstructions: "manual final contract",
  });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    return method === "thread/resume" ? inheritedThread("thread-1") : {};
  };

  await codex.ensureThread();

  assert.deepEqual(requests.map(({ method }) => method), ["thread/resume", "thread/inject_items"]);
  assert.equal(requests[1].params.threadId, "thread-1");
  assert.equal(requests[1].params.items[0].role, "developer");
  assert.equal(requests[1].params.items[0].content[0].text, "manual final contract");
});

test("omitted reasoning override resumes with the current native model default, not stale metadata", async () => {
  const codex = configuredCodex({ threadId: "thread-1" });
  codex.effectiveConfig.model_reasoning_effort = null;
  codex.modelPerformanceDefaults = { reasoningEffort: "medium", serviceTier: "priority" };
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return { ...inheritedThread("thread-1"), reasoningEffort: "medium" };
  };

  await codex.ensureThread();

  assert.equal(codex.threadId, "thread-1");
  assert.deepEqual(request.params.config, { model_reasoning_effort: "medium" });
  assert.equal(codex.parityReport().performance.reasoningEffort.source, "native");
  assert.equal(codex.parityReport().performance.reasoningEffort.effective, "medium");
  assert.equal(codex.parityReport().performance.reasoningEffort.verified, true);
  assert.equal(codex.parityReport().effectiveVerified, true);
});

test("restart resumes the same overridden thread and later turns inherit the process overlay", async () => {
  const saved = [];
  const codex = configuredCodex({
    threadId: "thread-1",
    codexOverrides: { reasoningEffort: "xhigh", fastMode: true },
    onThreadId: async (id) => saved.push(id),
  });
  const requests = [];
  codex.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/resume") return inheritedThread("thread-1");
    return { turn: { id: "turn-1" } };
  };

  await codex.ensureThread();
  await codex.startTurn([{ type: "text", text: "next" }]);

  assert.equal(codex.threadId, "thread-1");
  assert.deepEqual(requests.map(({ method }) => method), ["thread/resume", "turn/start"]);
  assert.deepEqual(requests[0].params, {
    threadId: "thread-1",
    cwd: "/tmp",
    serviceTier: "priority",
    config: { model_reasoning_effort: "xhigh" },
  });
  assert.deepEqual(Object.keys(requests[1].params).sort(), ["input", "threadId"]);
  assert.deepEqual(saved, ["thread-1", "thread-1"]);
  assert.equal(codex.parityReport().effectiveVerified, true);
});

test("changed performance overrides replace an incompatible resumed thread", async () => {
  const codex = configuredCodex({
    threadId: "thread-old",
    codexOverrides: { reasoningEffort: "xhigh", fastMode: true },
  });
  const methods = [];
  codex.request = async (method) => {
    methods.push(method);
    if (method === "thread/resume") {
      return { ...inheritedThread("thread-old"), reasoningEffort: "medium", serviceTier: "default" };
    }
    return inheritedThread("thread-overridden");
  };

  await codex.ensureThread();

  assert.deepEqual(methods, ["thread/resume", "thread/start"]);
  assert.equal(codex.threadId, "thread-overridden");
  assert.equal(codex.parityReport().effectiveVerified, true);
});

test("steering never carries or mutates process overrides", async () => {
  const codex = configuredCodex({
    threadId: "thread-1",
    codexOverrides: { reasoningEffort: "max", fastMode: false, followUpMode: "steer" },
  });
  let request;
  codex.request = async (method, params) => {
    request = { method, params };
    return { turnId: "turn-active" };
  };

  await codex.steer("turn-active", [{ type: "text", text: "more" }]);

  assert.equal(request.method, "turn/steer");
  assert.deepEqual(Object.keys(request.params).sort(), ["expectedTurnId", "input", "threadId"]);
});

test("replaces a resumed thread when an effective performance value is unreported", async () => {
  const codex = configuredCodex({ threadId: "thread-1" });
  const methods = [];
  codex.request = async (method) => {
    methods.push(method);
    return method === "thread/resume"
      ? { ...inheritedThread("thread-1"), reasoningEffort: null }
      : inheritedThread("thread-new");
  };

  await codex.ensureThread();

  assert.deepEqual(methods, ["thread/resume", "thread/start"]);
  assert.equal(codex.threadId, "thread-new");
  assert.equal(codex.parityReport().inherited, true);
  assert.equal(codex.parityReport().effectiveVerified, true);
  assert.deepEqual(codex.parityReport().unreported, []);
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
    config: { projectId: "project", allowedSender: TEST_SENDER, cwd: "/tmp", maxAttachmentBytes: 1024 },
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

test("removes Photon credentials but preserves the non-secret control home", () => {
  assert.deepEqual(codexEnvironment({
    PATH: "/usr/bin",
    CODEX_HOME: "/tmp/codex-home",
    PHOTON_PROJECT_SECRET: "secret",
    PHOTON_CODEX_HOME: "/tmp/photon-home",
  }), {
    PATH: "/usr/bin",
    CODEX_HOME: "/tmp/codex-home",
    PHOTON_CODEX_HOME: "/tmp/photon-home",
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

function rawControl(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => socket.destroy(new Error("test control request timed out")));
    socket.on("connect", () => {
      if (payload) socket.write(payload);
    });
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("end", () => {
      socket.destroy();
      resolve(output);
    });
    socket.on("error", reject);
  });
}

function framedControl(port, token, command, body, declaredBytes = body.byteLength) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let output = "";
    let ready = false;
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => socket.destroy(new Error("test framed request timed out")));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token, command, bodyBytes: declaredBytes })}\n`);
    });
    socket.on("data", (chunk) => {
      output += chunk;
      if (!ready && output.includes("\n")) {
        ready = true;
        output = "";
        socket.write(body);
      }
    });
    socket.on("end", () => {
      socket.destroy();
      resolve(output);
    });
    socket.on("error", reject);
  });
}
