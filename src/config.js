import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYCHAIN_SERVICE = "photon-codex";
const REASONING_EFFORTS = new Map([
  ["light", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["extra high", "xhigh"],
  ["max", "max"],
]);
const DISPLAY_REASONING_EFFORTS = new Map(Array.from(REASONING_EFFORTS, ([display, native]) => [native, display]));

export function appHome(env = process.env) {
  return path.resolve(env.PHOTON_CODEX_HOME || path.join(os.homedir(), ".config", "photon-codex"));
}

export function configPath(env = process.env) {
  return path.join(appHome(env), "config.json");
}

export function statePath(env = process.env) {
  return path.join(appHome(env), "state.json");
}

export function workspacePath(env = process.env) {
  return path.join(appHome(env), "workspace");
}

export function attachmentsPath(env = process.env) {
  return path.join(appHome(env), "attachments");
}

export function runtimeLogPath(env = process.env) {
  return path.join(appHome(env), "runtime.log");
}

export async function ensureHome(env = process.env) {
  const home = appHome(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  return home;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  await chmod(file, 0o600);
}

export function normalizeSender(value) {
  const normalized = String(value || "").replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("allowedSender must be an E.164 phone number such as +15551234567");
  }
  return normalized;
}

export async function loadConfig(env = process.env) {
  await ensureHome(env);
  const stored = await readJson(configPath(env), {});
  const config = {
    projectId: env.PHOTON_PROJECT_ID || stored.projectId,
    allowedSender: env.PHOTON_CODEX_ALLOWED_SENDER || stored.allowedSender,
    cwd: path.resolve(env.PHOTON_CODEX_CWD || stored.cwd || workspacePath(env)),
    maxAttachmentBytes: Number(env.PHOTON_CODEX_MAX_ATTACHMENT_BYTES || stored.maxAttachmentBytes || 50 * 1024 * 1024),
    codexOverrides: normalizeCodexOverrides(stored.codexOverrides),
  };
  if (!config.projectId) throw new Error("Photon project ID is missing. Run `photon-codex init`.");
  config.allowedSender = normalizeSender(config.allowedSender);
  if (!Number.isSafeInteger(config.maxAttachmentBytes) || config.maxAttachmentBytes <= 0) {
    throw new Error("maxAttachmentBytes must be a positive integer");
  }
  return config;
}

export async function saveConfig(config, env = process.env) {
  const suppliedOverrides = config.codexOverrides || {};
  const codexOverrides = normalizeCodexOverrides({
    ...suppliedOverrides,
    ...(DISPLAY_REASONING_EFFORTS.has(suppliedOverrides.reasoningEffort) ? {
      reasoningEffort: DISPLAY_REASONING_EFFORTS.get(suppliedOverrides.reasoningEffort),
    } : {}),
  });
  const value = {
    projectId: String(config.projectId).trim(),
    allowedSender: normalizeSender(config.allowedSender),
    cwd: path.resolve(config.cwd),
    maxAttachmentBytes: Number(config.maxAttachmentBytes || 50 * 1024 * 1024),
    ...(Object.keys(codexOverrides).length ? { codexOverrides: serializeCodexOverrides(codexOverrides) } : {}),
  };
  if (!value.projectId) throw new Error("projectId is required");
  await ensureHome(env);
  await writeJson(configPath(env), value);
  return value;
}

export function emptyState() {
  return {
    version: 3,
    threadId: null,
    spaceId: null,
    acceptedMessageIds: [],
    repliedMessageIds: [],
    ignoredEventIds: [],
    messageQueue: [],
    control: null,
    runtime: {
      startedAt: null,
      stoppedAt: null,
      lastEventAt: null,
      lastReplyAt: null,
      lastErrorAt: null,
      lastError: null,
      acceptedMessages: 0,
      repliesSent: 0,
      repliesFailed: 0,
      ignoredEvents: 0,
    },
  };
}

export async function loadState(env = process.env) {
  await ensureHome(env);
  return normalizeState(await readJson(statePath(env), emptyState()));
}

export async function saveState(state, env = process.env) {
  const next = normalizeState(state);
  await writeJson(statePath(env), next);
  return next;
}

export function normalizeState(state = {}) {
  const defaults = emptyState();
  const resetsLegacyThread = Number(state.version || 0) < 3;
  const legacyIds = Array.isArray(state.seenMessageIds) ? state.seenMessageIds : [];
  const legacyReceipts = legacyIds.filter(isReceiptEventId);
  const acceptedMessageIds = state.acceptedMessageIds || legacyIds.filter((id) => !isReceiptEventId(id));
  const ignoredEventIds = state.ignoredEventIds || legacyReceipts;
  const runtime = { ...defaults.runtime, ...(state.runtime || {}) };
  if (!state.runtime) {
    runtime.acceptedMessages = acceptedMessageIds.length;
    runtime.ignoredEvents = ignoredEventIds.length;
  }
  return {
    ...defaults,
    ...state,
    version: 3,
    threadId: resetsLegacyThread ? null : state.threadId || null,
    acceptedMessageIds: boundedIds(acceptedMessageIds),
    repliedMessageIds: boundedIds(state.repliedMessageIds),
    ignoredEventIds: boundedIds(ignoredEventIds),
    messageQueue: normalizeMessageQueue(state.messageQueue),
    runtime,
    control: state.control || null,
    seenMessageIds: undefined,
  };
}

function boundedIds(ids) {
  return Array.from(new Set(Array.isArray(ids) ? ids : [])).slice(-512);
}

function normalizeMessageQueue(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((entry) =>
    entry && typeof entry.messageId === "string" && Array.isArray(entry.input),
  ).slice(-100).map((entry) => ({ messageId: entry.messageId, input: entry.input }));
}

function isReceiptEventId(id) {
  return /:(?:read|delivered|delivery):/i.test(String(id || ""));
}

export function readProjectSecret(projectId, env = process.env) {
  if (env.PHOTON_PROJECT_SECRET) return env.PHOTON_PROJECT_SECRET;
  if (process.platform !== "darwin") {
    throw new Error("PHOTON_PROJECT_SECRET is missing");
  }
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", projectId, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error("Photon project secret is missing. Run `photon-codex auth set`.");
  }
}

export function setProjectSecret(projectId) {
  if (process.platform !== "darwin") {
    throw new Error("Keychain setup is available on macOS. Set PHOTON_PROJECT_SECRET on this platform.");
  }
  const result = spawnSync(
    "security",
    ["add-generic-password", "-U", "-a", projectId, "-s", KEYCHAIN_SERVICE, "-w"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("The Photon secret was not saved to Keychain");
}

export function redactConfig(config) {
  return {
    projectId: config.projectId,
    allowedSender: `${config.allowedSender.slice(0, 4)}…${config.allowedSender.slice(-3)}`,
    cwd: config.cwd,
    maxAttachmentBytes: config.maxAttachmentBytes,
    codexOverrides: config.codexOverrides || {},
  };
}

export function normalizeCodexOverrides(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("codexOverrides must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !["reasoningEffort", "fastMode"].includes(key));
  if (unknown.length) throw new Error(`codexOverrides contains unsupported field: ${unknown.join(", ")}`);
  const overrides = {};
  if (Object.hasOwn(value, "reasoningEffort")) {
    if (typeof value.reasoningEffort !== "string") {
      throw new Error("codexOverrides.reasoningEffort must be light, medium, high, extra high, or max");
    }
    const normalized = REASONING_EFFORTS.get(value.reasoningEffort.trim().toLowerCase().replace(/\s+/g, " "));
    if (!normalized) {
      throw new Error("codexOverrides.reasoningEffort must be light, medium, high, extra high, or max");
    }
    overrides.reasoningEffort = normalized;
  }
  if (Object.hasOwn(value, "fastMode")) {
    if (typeof value.fastMode !== "boolean") throw new Error("codexOverrides.fastMode must be true or false");
    overrides.fastMode = value.fastMode;
  }
  return overrides;
}

function serializeCodexOverrides(overrides) {
  return {
    ...(overrides.reasoningEffort ? {
      reasoningEffort: DISPLAY_REASONING_EFFORTS.get(overrides.reasoningEffort),
    } : {}),
    ...(Object.hasOwn(overrides, "fastMode") ? { fastMode: overrides.fastMode } : {}),
  };
}
