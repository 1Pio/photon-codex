import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { credentialFreeEnvironment } from "./config.js";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;

const MACOS_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
const NATIVE_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const NATIVE_FOLLOW_UP_MODES = new Set(["queue", "steer"]);
const DISPLAY_REASONING_EFFORT = new Map([
  ["low", "light"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "extra high"],
  ["max", "max"],
]);

export class CodexAppServer extends EventEmitter {
  constructor({ cwd, threadId = null, ephemeral = false, env = process.env, transportInstructions = null, codexOverrides = {}, onThreadId }) {
    super();
    this.cwd = path.resolve(cwd);
    this.threadId = threadId;
    this.ephemeral = ephemeral;
    this.env = env;
    this.executable = codexExecutable(env);
    this.transportInstructions = transportInstructions;
    this.codexOverrides = codexOverrides;
    this.onThreadId = onThreadId;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.effectiveConfig = null;
    this.modelPerformanceDefaults = {};
    this.threadSettings = null;
    this.account = null;
    this.stopping = false;
  }

  async start() {
    if (this.process) return;
    this.stopping = false;
    this.process = spawn(this.executable, codexAppServerArgs(this.codexOverrides), {
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
    if (this.effectiveConfig.model_reasoning_effort == null || this.effectiveConfig.service_tier == null) {
      const models = await this.request("model/list", { limit: 100, includeHidden: true });
      this.modelPerformanceDefaults = modelPerformanceDefaults(this.effectiveConfig, models.data || []);
    }
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
        ...resumePerformanceParams(effectivePerformance(this.effectiveConfig, this.modelPerformanceDefaults)),
      });
      this.threadId = result.thread?.id || this.threadId;
      this.#captureThreadSettings(result);
      const parity = this.parityReport();
      if (!parity.effectiveVerified) return this.newThread();
      await this.#injectTransportInstructions();
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
      ...resumePerformanceParams(effectivePerformance(this.effectiveConfig, this.modelPerformanceDefaults)),
    });
    this.threadId = result.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread ID");
    this.#captureThreadSettings(result);
    const parity = this.parityReport();
    if (!parity.effectiveVerified) {
      const failures = [
        ...parity.mismatches,
        ...Object.entries(parity.performance)
          .filter(([, value]) => !value.verified)
          .map(([setting]) => `${setting} unverified`),
        ...(!parity.followUpMode.verified ? ["followUpMode unverified"] : []),
      ];
      throw new Error(`Codex config parity check failed: ${Array.from(new Set(failures)).join(", ")}`);
    }
    await this.#injectTransportInstructions();
    await this.onThreadId(this.threadId);
    return this.threadId;
  }

  async #injectTransportInstructions() {
    if (!this.transportInstructions) return;
    await this.request("thread/inject_items", {
      threadId: this.threadId,
      items: [{
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: this.transportInstructions }],
      }],
    });
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

  followUpMode() {
    return effectiveFollowUpMode(this.effectiveConfig);
  }

  parityReport() {
    const config = this.effectiveConfig || {};
    const settings = this.threadSettings || {};
    const expectedPerformance = effectivePerformance(config, this.modelPerformanceDefaults);
    const checks = [];
    const unreported = [];
    compareReported(checks, unreported, "cwd", this.cwd, settings.cwd, normalizePath);
    compareReported(checks, unreported, "model", config.model, settings.model);
    compareReported(checks, unreported, "modelProvider", config.model_provider, settings.modelProvider);
    compareReported(checks, unreported, "reasoningEffort", expectedPerformance.reasoningEffort, settings.effort);
    compareReported(checks, unreported, "reasoningSummary", config.model_reasoning_summary, settings.summary);
    compareReported(checks, unreported, "serviceTier", expectedPerformance.serviceTier, settings.serviceTier, normalizeServiceTier);
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
    const performance = performanceReport(this.codexOverrides, config, settings, expectedPerformance);
    const followUpMode = followUpModeReport(this.codexOverrides, config);
    const overriddenSettings = new Set([
      ...(Object.hasOwn(this.codexOverrides, "reasoningEffort") ? ["reasoningEffort"] : []),
      ...(Object.hasOwn(this.codexOverrides, "fastMode") ? ["serviceTier"] : []),
    ]);
    const inherited = Boolean(this.effectiveConfig && this.threadSettings
      && checks.filter((check) => !overriddenSettings.has(check.setting)).every((check) => check.matches));
    const effectiveVerified = inherited && mismatches.length === 0
      && performanceVerified(performance) && followUpMode.verified;
    return {
      inherited,
      effectiveVerified,
      verified: effectiveVerified && unreported.length === 0,
      source: Object.keys(this.codexOverrides).length
        ? "Codex native configuration with photon-codex overrides"
        : "Codex native configuration",
      overrides: [
        ...(Object.hasOwn(this.codexOverrides, "reasoningEffort") ? ["reasoningEffort"] : []),
        ...(Object.hasOwn(this.codexOverrides, "fastMode") ? ["fastMode"] : []),
        ...(Object.hasOwn(this.codexOverrides, "followUpMode") ? ["followUpMode"] : []),
      ],
      mismatches,
      unreported,
      performance,
      followUpMode,
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

export function codexAppServerArgs(overrides = {}) {
  const args = ["app-server", "--listen", "stdio://"];
  if (Object.hasOwn(overrides, "reasoningEffort")) {
    if (!NATIVE_REASONING_EFFORTS.has(overrides.reasoningEffort)) {
      throw new Error("Invalid native Codex reasoning effort override");
    }
    args.push("--config", `model_reasoning_effort=${JSON.stringify(overrides.reasoningEffort)}`);
  }
  if (Object.hasOwn(overrides, "fastMode")) {
    if (typeof overrides.fastMode !== "boolean") throw new Error("Invalid Codex fast mode override");
    args.push("--config", `service_tier=${JSON.stringify(overrides.fastMode ? "fast" : "default")}`);
  }
  if (Object.hasOwn(overrides, "followUpMode")) {
    if (!NATIVE_FOLLOW_UP_MODES.has(overrides.followUpMode)) {
      throw new Error("Invalid Codex follow-up mode override");
    }
    args.push("--config", `desktop.followUpQueueMode=${JSON.stringify(overrides.followUpMode)}`);
  }
  return args;
}

export function codexEnvironment(env = process.env) {
  const child = credentialFreeEnvironment(env);
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

function performanceReport(overrides, config, settings, expected) {
  const reasoningOverride = Object.hasOwn(overrides, "reasoningEffort");
  const fastOverride = Object.hasOwn(overrides, "fastMode");
  const configTier = normalizeServiceTier(config.service_tier);
  const threadTier = normalizeServiceTier(settings.serviceTier);
  const expectedTier = normalizeServiceTier(expected.serviceTier);
  const expectedEffort = expected.reasoningEffort;
  return {
    reasoningEffort: {
      source: reasoningOverride ? "override" : "native",
      configured: reasoningOverride ? DISPLAY_REASONING_EFFORT.get(overrides.reasoningEffort) : null,
      effective: expectedEffort ?? null,
      thread: settings.effort ?? null,
      verified: expectedEffort == null
        ? settings.effort == null
        : (!reasoningOverride || config.model_reasoning_effort === expectedEffort) && settings.effort === expectedEffort,
    },
    fastMode: {
      source: fastOverride ? "override" : "native",
      configured: fastOverride ? overrides.fastMode : null,
      effective: expectedTier === "priority",
      serviceTier: expectedTier ?? null,
      threadServiceTier: threadTier ?? null,
      verified: expectedTier == null
        ? threadTier == null
        : (!fastOverride || configTier === expectedTier) && threadTier === expectedTier,
    },
  };
}

function performanceVerified(performance) {
  return Object.values(performance || {}).every((value) => value.verified);
}

function followUpModeReport(overrides, config) {
  const overridden = Object.hasOwn(overrides, "followUpMode");
  const raw = config.desktop?.followUpQueueMode ?? null;
  const effective = effectiveFollowUpMode(config);
  return {
    source: overridden ? "override" : "native",
    configured: overridden ? overrides.followUpMode : null,
    effective,
    configValue: raw,
    verified: effective != null && (!overridden || raw === overrides.followUpMode),
  };
}

function effectiveFollowUpMode(config = {}) {
  const value = config.desktop?.followUpQueueMode;
  if (value == null) return "steer";
  if (value === "interrupt") return "steer";
  return NATIVE_FOLLOW_UP_MODES.has(value) ? value : null;
}

function resumePerformanceParams(performance = {}) {
  return {
    ...(performance.serviceTier != null ? { serviceTier: performance.serviceTier } : {}),
    ...(performance.reasoningEffort != null ? {
      config: { model_reasoning_effort: performance.reasoningEffort },
    } : {}),
  };
}

function effectivePerformance(config = {}, defaults = {}) {
  return {
    reasoningEffort: config.model_reasoning_effort ?? defaults.reasoningEffort ?? null,
    serviceTier: config.service_tier ?? defaults.serviceTier ?? null,
  };
}

export function modelPerformanceDefaults(config, models) {
  const model = config.model == null
    ? models.find((entry) => entry.isDefault)
    : models.find((entry) => entry.model === config.model || entry.id === config.model);
  return {
    reasoningEffort: model?.defaultReasoningEffort ?? null,
    serviceTier: model ? model.defaultServiceTier ?? "default" : null,
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
