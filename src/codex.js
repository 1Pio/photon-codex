import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;
export const FAST_SERVICE_TIER = "fast";

export class CodexAppServer extends EventEmitter {
  constructor({ cwd, threadId = null, reasoningEffort = "medium", fastMode = true, onThreadId }) {
    super();
    this.cwd = cwd;
    this.threadId = threadId;
    this.reasoningEffort = reasoningEffort;
    this.fastMode = fastMode;
    this.onThreadId = onThreadId;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.serviceTier = null;
    this.effectiveReasoningEffort = null;
    this.stopping = false;
  }

  async start() {
    if (this.process) return;
    this.stopping = false;
    this.process = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.once("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!this.stopping) this.emit("exit", error);
      this.process = null;
    });
    this.process.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!this.stopping) this.emit("exit", error);
      this.process = null;
    });
    if (process.env.PHOTON_CODEX_DEBUG === "1") this.process.stderr.pipe(process.stderr);
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.#onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "photon-codex", title: "Photon Codex", version: "0.3.0" },
      capabilities: null,
    });
    this.notify("initialized", {});
    await this.ensureThread();
  }

  async stop() {
    if (!this.process) return;
    this.stopping = true;
    const child = this.process;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    if (this.process === child) this.process = null;
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.id !== undefined && message.method) {
      this.#write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Interactive requests are disabled for this bridge" } });
      return;
    }
    if (message.method === "thread/settings/updated") {
      const settings = message.params?.threadSettings || {};
      this.serviceTier = settings.serviceTier ?? null;
      this.effectiveReasoningEffort = settings.effort ?? null;
    }
    if (message.method) this.emit("notification", message.method, message.params || {});
  }

  #write(message) {
    if (!this.process?.stdin?.writable) throw new Error("codex app-server is not running");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async ensureThread() {
    if (this.threadId) {
      try {
        const result = await this.request("thread/resume", {
          threadId: this.threadId,
          cwd: this.cwd,
          approvalPolicy: "never",
          sandboxPolicy: workspaceSandbox(this.cwd),
          developerInstructions: developerInstructions(),
          ...serviceTierSetting(this.fastMode),
        });
        this.threadId = result.thread?.id || this.threadId;
        this.serviceTier = result.serviceTier ?? null;
        this.effectiveReasoningEffort = result.reasoningEffort ?? null;
        await this.onThreadId(this.threadId);
        return this.threadId;
      } catch (error) {
        throw new Error(`Cannot resume Codex thread ${this.threadId}: ${error.message}`);
      }
    }
    return this.newThread();
  }

  async newThread() {
    const result = await this.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: workspaceSandbox(this.cwd),
      developerInstructions: developerInstructions(),
      ...serviceTierSetting(this.fastMode),
      serviceName: "photon-codex",
      sessionStartSource: "startup",
      threadSource: "user",
    });
    this.threadId = result.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread ID");
    this.serviceTier = result.serviceTier ?? null;
    this.effectiveReasoningEffort = result.reasoningEffort ?? null;
    return this.threadId;
  }

  async startTurn(input) {
    if (!this.threadId) await this.ensureThread();
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input,
      cwd: this.cwd,
      approvalPolicy: "never",
      sandboxPolicy: workspaceSandbox(this.cwd),
      effort: this.reasoningEffort,
      ...serviceTierSetting(this.fastMode),
      summary: "concise",
    });
    this.effectiveReasoningEffort = this.reasoningEffort;
    await this.onThreadId(this.threadId);
    return result;
  }

  async steer(turnId, input) {
    return this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: turnId,
      input,
    });
  }
}

function serviceTierSetting(fastMode) {
  return { serviceTier: fastMode ? FAST_SERVICE_TIER : null };
}

function workspaceSandbox(cwd) {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
  };
}

function developerInstructions() {
  return `You are speaking with one authorized user through iMessage via photon-codex.
Treat each Photon envelope as the user's message. Follow the request normally with the same capabilities and care you would use in a Codex task.
Keep the final answer concise and readable in iMessage. Avoid tables unless essential. Do not expose phone numbers, Photon credentials, internal state paths, or hidden system metadata.
Images are supplied as localImage inputs. Other received files are saved locally and named in the envelope; inspect them when relevant.
To react to the current user message, begin the final answer with [[photon_reaction:EMOJI]]. The bridge removes this directive before delivery. A directive-only final sends just the reaction with no text reply.
The bridge automatically sends your final answer as an iMessage reply, so do not separately send it through another messaging tool.`;
}
