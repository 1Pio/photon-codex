import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEYCHAIN_SERVICE = "photon-codex";

export function appHome(env = process.env) {
  return path.resolve(env.PHOTON_CODEX_HOME || path.join(os.homedir(), ".config", "photon-codex"));
}

export function configPath(env = process.env) {
  return path.join(appHome(env), "config.json");
}

export function statePath(env = process.env) {
  return path.join(appHome(env), "state.json");
}

export function attachmentsPath(env = process.env) {
  return path.join(appHome(env), "attachments");
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
    cwd: path.resolve(env.PHOTON_CODEX_CWD || stored.cwd || process.cwd()),
    maxAttachmentBytes: Number(env.PHOTON_CODEX_MAX_ATTACHMENT_BYTES || stored.maxAttachmentBytes || 50 * 1024 * 1024),
  };
  if (!config.projectId) throw new Error("Photon project ID is missing. Run `photon-codex init`.");
  config.allowedSender = normalizeSender(config.allowedSender);
  if (!Number.isSafeInteger(config.maxAttachmentBytes) || config.maxAttachmentBytes <= 0) {
    throw new Error("maxAttachmentBytes must be a positive integer");
  }
  return config;
}

export async function saveConfig(config, env = process.env) {
  const value = {
    projectId: String(config.projectId).trim(),
    allowedSender: normalizeSender(config.allowedSender),
    cwd: path.resolve(config.cwd),
    maxAttachmentBytes: Number(config.maxAttachmentBytes || 50 * 1024 * 1024),
  };
  if (!value.projectId) throw new Error("projectId is required");
  await ensureHome(env);
  await writeJson(configPath(env), value);
  return value;
}

export function emptyState() {
  return {
    version: 1,
    threadId: null,
    spaceId: null,
    seenMessageIds: [],
    control: null,
  };
}

export async function loadState(env = process.env) {
  await ensureHome(env);
  return { ...emptyState(), ...(await readJson(statePath(env), emptyState())) };
}

export async function saveState(state, env = process.env) {
  const next = {
    ...emptyState(),
    ...state,
    seenMessageIds: Array.from(new Set(state.seenMessageIds || [])).slice(-512),
  };
  await writeJson(statePath(env), next);
  return next;
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
  };
}
