import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhone, safeName, splitMessage } from "../src/bridge.js";
import { CodexAppServer } from "../src/codex.js";
import { normalizeSender } from "../src/config.js";

test("normalizes E.164 input without weakening validation", () => {
  assert.equal(normalizeSender("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizePhone("+971 58 123 4567"), "+971581234567");
  assert.throws(() => normalizeSender("555-1234"));
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

test("starts each turn on the loaded thread without resuming again", async () => {
  const saved = [];
  const codex = new CodexAppServer({ cwd: "/tmp", threadId: "thread-1", onThreadId: async (id) => saved.push(id) });
  const methods = [];
  codex.request = async (method) => {
    methods.push(method);
    return { turn: { id: "turn-1" } };
  };

  await codex.startTurn([{ type: "text", text: "hello" }]);

  assert.deepEqual(methods, ["turn/start"]);
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
