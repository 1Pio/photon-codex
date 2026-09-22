import readline from "node:readline";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const config = {
  model: "test-model",
  model_provider: "openai",
  model_reasoning_effort: "medium",
  service_tier: "default",
  approval_policy: "on-request",
  sandbox_mode: "workspace-write",
  desktop: { followUpQueueMode: "steer" },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") {
    if (process.env.CODEX_TEST_NOISY === "1") {
      // More than the OS pipe and Node readable buffers can hold unconsumed.
      await new Promise((resolve) => process.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"), resolve));
    }
    reply(id, {});
  } else if (method === "config/read") {
    reply(id, { config });
  } else if (method === "account/read") {
    reply(id, { account: null });
  } else if (method === "thread/resume" || method === "thread/start") {
    // Emulate expensive history hydration. This client does not need it.
    if (method === "thread/resume" && params.excludeTurns !== true) continue;
    reply(id, {
      thread: { id: params.threadId || "new-thread", turns: [] },
      cwd: params.cwd,
      model: config.model,
      modelProvider: config.model_provider,
      reasoningEffort: config.model_reasoning_effort,
      serviceTier: config.service_tier,
      approvalPolicy: config.approval_policy,
      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    });
  } else if (method === "thread/inject_items") {
    reply(id, {});
  } else if (method === "turn/start") {
    reply(id, { turn: { id: "turn-1" } });
  } else if (method === "test/exit") {
    process.exit(2);
  }
}
