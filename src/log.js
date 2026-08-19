import { appendFile, chmod, rename, stat } from "node:fs/promises";
import { ensureHome, runtimeLogPath } from "./config.js";

const MAX_LOG_BYTES = 512 * 1024;
const LEVELS = new Set(["info", "warn", "error"]);
const PHASES = new Set(["commentary", "control", "final_answer", "unknown"]);
const CONTENT_TYPES = new Set([
  "attachment", "codex-interaction", "expired-codex-interaction", "markdown", "reaction", "reply", "text", "unknown", "voice",
]);
const OPERATIONS = new Set([
  "auth", "doctor", "edit", "help", "init", "logs", "progress", "react", "reply", "run", "send", "send-file", "send-stack", "service", "status", "stop", "thread", "workspace",
]);
const ERROR_CATEGORIES = new Set(["attachment", "codex", "control", "filesystem", "photon", "runtime"]);
const ERROR_CODES = new Set([
  "authentication", "configuration", "connection", "invalid_input", "not_found", "permission_denied", "provider_rejected", "size_limit", "timeout", "unavailable", "unexpected",
]);
const EVENT_FIELDS = new Map([
  ["bridge_starting", {}],
  ["bridge_ready", { configParity: booleanValue, threadBound: booleanValue }],
  ["bridge_stopped", {}],
  ["file_sent", { size: countValue, providerDelivered: booleanValue }],
  ["progress_sent", {}],
  ["message_edited", { phase: (value) => enumValue(value, PHASES) }],
  ["message_edit_failed", errorFields({ phase: (value) => enumValue(value, PHASES) })],
  ["stack_sent", { count: countValue }],
  ["stack_send_failed", errorFields({ count: countValue, failedIndex: countValue, sentCount: countValue })],
  ["reaction_sent", { phase: (value) => enumValue(value, PHASES) }],
  ["reaction_failed", errorFields({ phase: (value) => enumValue(value, PHASES) })],
  ["reaction_directive_invalid", { phase: (value) => enumValue(value, PHASES) }],
  ["event_ignored", { contentType: (value) => enumValue(value, CONTENT_TYPES) }],
  ["message_accepted", { contentType: (value) => enumValue(value, CONTENT_TYPES) }],
  ["message_queued", { contentType: (value) => enumValue(value, CONTENT_TYPES) }],
  ["reply_sent", {}],
  ["codex_form_declined", { mode: (value) => enumValue(value, new Set(["form", "openai/form"]), "other") }],
  ["codex_request_unsupported", {}],
  ["cli_failed", errorFields({ operation: (value) => enumValue(value, OPERATIONS) })],
  ["codex_interaction_failed", errorFields({ contentType: (value) => enumValue(value, CONTENT_TYPES) })],
  ["codex_notification_failed", errorFields()],
  ["codex_request_failed", errorFields()],
  ["message_failed", errorFields({ contentType: (value) => enumValue(value, CONTENT_TYPES) })],
]);

export async function logEvent(level, event, details = {}, env = process.env) {
  try {
    await ensureHome(env);
    const file = runtimeLogPath(env);
    await rotateIfNeeded(file);
    const entry = {
      time: new Date().toISOString(),
      level: LEVELS.has(level) ? level : "error",
      event: EVENT_FIELDS.has(event) ? event : "log_event_rejected",
      ...safeDetails(event, details),
    };
    await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  } catch {
    // Logging must never terminate the bridge.
  }
}

async function rotateIfNeeded(file) {
  try {
    if ((await stat(file)).size < MAX_LOG_BYTES) return;
    await rename(file, `${file}.1`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function safeDetails(event, details) {
  const schema = EVENT_FIELDS.get(event);
  if (!schema || !details || typeof details !== "object") return {};
  const output = {};
  for (const [key, normalize] of Object.entries(schema)) {
    const value = normalize(details[key]);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function errorFields(extra = {}) {
  return {
    ...extra,
    errorCategory: (value) => enumValue(value, ERROR_CATEGORIES),
    errorCode: (value) => enumValue(value, ERROR_CODES),
  };
}

function enumValue(value, allowed, fallback = "unknown") {
  return allowed.has(value) ? value : fallback;
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : undefined;
}

function countValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
