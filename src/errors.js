const ERROR_EVENTS = new Set([
  "cli_failed",
  "codex_interaction_failed",
  "codex_notification_failed",
  "codex_request_failed",
  "message_failed",
  "reaction_failed",
]);

const ERROR_CATEGORIES = new Set(["attachment", "codex", "control", "filesystem", "photon", "runtime"]);
const ERROR_CODES = new Set([
  "authentication",
  "configuration",
  "connection",
  "invalid_input",
  "not_found",
  "permission_denied",
  "provider_rejected",
  "size_limit",
  "timeout",
  "unavailable",
  "unexpected",
]);

const EVENT_CATEGORIES = new Map([
  ["cli_failed", "control"],
  ["codex_interaction_failed", "codex"],
  ["codex_notification_failed", "codex"],
  ["codex_request_failed", "codex"],
  ["message_failed", "photon"],
  ["reaction_failed", "photon"],
]);

export function safeErrorRecord(event, error) {
  const safeEvent = ERROR_EVENTS.has(event) ? event : "message_failed";
  return {
    event: safeEvent,
    category: categoryFor(safeEvent, error),
    code: codeFor(error),
  };
}

export function normalizeSafeErrorRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ERROR_EVENTS.has(value.event) || !ERROR_CATEGORIES.has(value.category) || !ERROR_CODES.has(value.code)) return null;
  return { event: value.event, category: value.category, code: value.code };
}

function categoryFor(event, error) {
  const message = errorText(error);
  if (/attachment|base64|mime|sha-?256|file snapshot/.test(message)) return "attachment";
  if (/eacces|eperm|permission denied/.test(message)) return "filesystem";
  return EVENT_CATEGORIES.get(event) || "runtime";
}

function codeFor(error) {
  const systemCode = String(error?.code || "").toUpperCase();
  if (["EACCES", "EPERM"].includes(systemCode)) return "permission_denied";
  if (systemCode === "ENOENT") return "not_found";
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTCONN"].includes(systemCode)) return "connection";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(systemCode)) return "timeout";

  const message = errorText(error);
  if (/unauthori[sz]ed|authentication|credential|secret is missing/.test(message)) return "authentication";
  if (/timed? out|timeout/.test(message)) return "timeout";
  if (/exceeds|too large|size limit|body limit/.test(message)) return "size_limit";
  if (/not found|no .* found|could not be opened/.test(message)) return "not_found";
  if (/invalid|malformed|unexpected token|canonical base64|must be|is required|does not match/.test(message)) return "invalid_input";
  if (/config|missing|required|not configured/.test(message)) return "configuration";
  if (/did not return|not sent|transfer failed|provider rejected|send error/.test(message)) return "provider_rejected";
  if (/not running|unavailable|exited|stream ended|cannot resume/.test(message)) return "unavailable";
  return "unexpected";
}

function errorText(error) {
  return String(error?.message || error || "").toLowerCase();
}
