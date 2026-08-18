import { appendFile, chmod, rename, stat } from "node:fs/promises";
import { ensureHome, runtimeLogPath } from "./config.js";

const MAX_LOG_BYTES = 512 * 1024;

export async function logEvent(level, event, details = {}, env = process.env) {
  try {
    await ensureHome(env);
    const file = runtimeLogPath(env);
    await rotateIfNeeded(file);
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...safeDetails(details),
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

function safeDetails(details) {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, cleanValue(value)]),
  );
}

function cleanValue(value) {
  if (typeof value === "string") return value.replace(/[\r\n]+/g, " ").slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return String(value).slice(0, 500);
}
