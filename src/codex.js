import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;

const MACOS_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;

export class CodexAppServer extends EventEmitter {
  constructor({ cwd, threadId = null, ephemeral = false, env = process.env, transportInstructions = null, onThreadId }) {
    super();
    this.cwd = path.resolve(cwd);
    this.threadId = threadId;
    this.ephemeral = ephemeral;
    this.env = env;
    this.executable = codexExecutable(env);
    this.transportInstructions = transportInstructions;
    this.onThreadId = onThreadId;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.effectiveConfig = null;
    this.threadSettings = null;
    this.account = null;
    this.stopping = false;
  }

  async start() {
    if (this.process) return;
    this.stopping = false;
    this.process = spawn(this.executable, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: codexEnvironment(this.env),
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
    if (this.env.PHOTON_CODEX_DEBUG === "1") this.process.stderr.pipe(process.stderr);
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.#onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "photon-codex", title: "Photon Codex", version: PACKAGE_VERSION },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    const [configResult, accountResult] = await Promise.all([
      this.request("config/read", { cwd: this.cwd, includeLayers: false }),
      this.request("account/read", { refreshToken: false }),
    ]);
    this.effectiveConfig = configResult.config || {};
    this.account = accountSummary(accountResult);
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
      this.emit("request", {
        id: message.id,
        method: message.method,
        params: message.params || {},
      });
      return;
    }
    if (message.method === "thread/settings/updated") {
      this.threadSettings = message.params?.threadSettings || this.threadSettings;
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

  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  reject(id, message, code = -32601) {
    this.#write({ jsonrpc: "2.0", id, error: { code, message } });
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
    if (!this.threadId) return this.newThread();
    try {
      const result = await this.request("thread/resume", {
        threadId: this.threadId,
        cwd: this.cwd,
      });
      this.threadId = result.thread?.id || this.threadId;
      this.#captureThreadSettings(result);
      if (this.parityReport().mismatches.length) return this.newThread();
      await this.onThreadId(this.threadId);
      return this.threadId;
    } catch (error) {
      throw new Error(`Cannot resume Codex thread ${this.threadId}: ${error.message}`);
    }
  }

  async newThread() {
    const result = await this.request("thread/start", {
      cwd: this.cwd,
      ...(this.ephemeral ? { ephemeral: true } : {}),
    });
    this.threadId = result.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread ID");
    this.#captureThreadSettings(result);
    const parity = this.parityReport();
    if (parity.mismatches.length) {
      throw new Error(`Codex config parity check failed: ${parity.mismatches.join(", ")}`);
    }
    if (this.transportInstructions) {
      await this.request("thread/inject_items", {
        threadId: this.threadId,
        items: [{
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: this.transportInstructions }],
        }],
      });
    }
    await this.onThreadId(this.threadId);
    return this.threadId;
  }

  async startTurn(input) {
    if (!this.threadId) await this.ensureThread();
    const result = await this.request("turn/start", {
      threadId: this.threadId,
      input,
    });
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

  configSummary() {
    return summarizeConfig(this.effectiveConfig);
  }

  parityReport() {
    const config = this.effectiveConfig || {};
    const settings = this.threadSettings || {};
    const checks = [];
    const unreported = [];
    compareReported(checks, unreported, "cwd", this.cwd, settings.cwd, normalizePath);
    compareReported(checks, unreported, "model", config.model, settings.model);
    compareReported(checks, unreported, "modelProvider", config.model_provider, settings.modelProvider);
    compareReported(checks, unreported, "reasoningEffort", config.model_reasoning_effort, settings.effort);
    compareReported(checks, unreported, "reasoningSummary", config.model_reasoning_summary, settings.summary);
    compareReported(checks, unreported, "serviceTier", config.service_tier, settings.serviceTier, normalizeServiceTier);
    compareReported(checks, unreported, "approvalPolicy", config.approval_policy, settings.approvalPolicy);
    compareReported(checks, unreported, "approvalsReviewer", config.approvals_reviewer, settings.approvalsReviewer);
    compareReported(checks, unreported, "sandboxMode", config.sandbox_mode, sandboxMode(settings.sandboxPolicy));
    if (config.sandbox_mode === "workspace-write" && config.sandbox_workspace_write?.network_access !== undefined) {
      compareReported(checks, unreported, "sandboxNetworkAccess", config.sandbox_workspace_write.network_access, settings.sandboxPolicy?.networkAccess);
    }
    if (settings.personality !== undefined) {
      compareReported(checks, unreported, "personality", config.personality, settings.personality);
    }
    const mismatches = checks.filter((check) => !check.matches).map((check) => check.setting);
    const inherited = Boolean(this.effectiveConfig && this.threadSettings && mismatches.length === 0);
    return {
      inherited,
      verified: inherited && unreported.length === 0,
      source: "Codex native configuration",
      overrides: [],
      mismatches,
      unreported,
      config: this.configSummary(),
      thread: summarizeThreadSettings(settings),
    };
  }

  #captureThreadSettings(result) {
    this.threadSettings = {
      cwd: result.cwd,
      approvalPolicy: result.approvalPolicy,
      approvalsReviewer: result.approvalsReviewer,
      sandboxPolicy: result.sandbox,
      model: result.model,
      modelProvider: result.modelProvider,
      serviceTier: result.serviceTier,
      effort: result.reasoningEffort,
      summary: result.reasoningSummary,
      personality: result.personality,
    };
  }
}

export function codexExecutable(env = process.env) {
  if (env.PHOTON_CODEX_BIN) {
    return path.isAbsolute(env.PHOTON_CODEX_BIN) || env.PHOTON_CODEX_BIN.includes(path.sep)
      ? path.resolve(env.PHOTON_CODEX_BIN)
      : env.PHOTON_CODEX_BIN;
  }
  if (process.platform === "darwin" && existsSync(MACOS_CODEX_BIN)) return MACOS_CODEX_BIN;
  return "codex";
}

export function codexEnvironment(env = process.env) {
  const child = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PHOTON_")));
  if (env.PHOTON_CODEX_HOME) child.PHOTON_CODEX_HOME = path.resolve(env.PHOTON_CODEX_HOME);
  return child;
}

export function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function summarizeConfig(config = {}) {
  return {
    model: config.model ?? null,
    reasoningEffort: config.model_reasoning_effort ?? null,
    reasoningSummary: config.model_reasoning_summary ?? null,
    serviceTier: config.service_tier ?? null,
    approvalPolicy: config.approval_policy ?? null,
    approvalsReviewer: config.approvals_reviewer ?? null,
    sandboxMode: config.sandbox_mode ?? null,
    sandboxNetworkAccess: config.sandbox_workspace_write?.network_access ?? null,
    personality: config.personality ?? null,
    webSearch: config.web_search ?? null,
    followUpQueueMode: config.desktop?.followUpQueueMode ?? null,
  };
}

function summarizeThreadSettings(settings = {}) {
  return {
    cwd: settings.cwd ?? null,
    model: settings.model ?? null,
    modelProvider: settings.modelProvider ?? null,
    reasoningEffort: settings.effort ?? null,
    reasoningSummary: settings.summary ?? null,
    serviceTier: settings.serviceTier ?? null,
    approvalPolicy: settings.approvalPolicy ?? null,
    approvalsReviewer: settings.approvalsReviewer ?? null,
    sandboxMode: sandboxMode(settings.sandboxPolicy),
    sandboxPolicy: settings.sandboxPolicy ?? null,
    personality: settings.personality ?? null,
  };
}

function accountSummary(result = {}) {
  const account = result.account;
  return {
    authenticated: Boolean(account) || result.requiresOpenaiAuth === false,
    type: account?.type ?? null,
    planType: account?.planType ?? null,
  };
}

function compareReported(checks, unreported, setting, expected, actual, normalize = identity) {
  if (expected === null || expected === undefined) return;
  if (actual === null || actual === undefined) {
    unreported.push(setting);
    return;
  }
  compare(checks, setting, expected, actual, normalize);
}

function compare(checks, setting, expected, actual, normalize = identity) {
  const normalizedExpected = normalize(expected);
  const normalizedActual = normalize(actual);
  checks.push({
    setting,
    matches: JSON.stringify(normalizedExpected) === JSON.stringify(normalizedActual),
  });
}

function sandboxMode(policy) {
  if (policy?.type === "workspaceWrite") return "workspace-write";
  if (policy?.type === "readOnly") return "read-only";
  if (policy?.type === "dangerFullAccess") return "danger-full-access";
  if (policy?.type === "externalSandbox") return "external-sandbox";
  return null;
}

function normalizeServiceTier(value) {
  return value === "fast" ? "priority" : value;
}

function normalizePath(value) {
  return typeof value === "string" ? path.resolve(value) : null;
}

function identity(value) {
  return value;
}
