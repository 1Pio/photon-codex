import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { appHome, runtimeLogPath } from "./config.js";

export const SERVICE_LABEL = "com.photon-codex.bridge";

export function servicePlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export async function installService(env = process.env) {
  requireMacOS();
  const plist = servicePlistPath();
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, launchAgentPlist(env), { encoding: "utf8", mode: 0o600 });
  await chmod(plist, 0o600);
  runLaunchctl(["bootout", serviceDomain()], { allowFailure: true });
  runLaunchctl(["bootstrap", userDomain(), plist]);
  return serviceStatus(env);
}

export async function startService() {
  requireMacOS();
  const plist = servicePlistPath();
  try {
    await readFile(plist);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("service is not installed; run `photon-codex service install`");
    throw error;
  }
  if (!serviceStatus().loaded) runLaunchctl(["bootstrap", userDomain(), plist]);
  else runLaunchctl(["kickstart", "-k", serviceDomain()]);
  return serviceStatus();
}

export function stopService() {
  requireMacOS();
  if (!serviceStatus().loaded) return serviceStatus();
  runLaunchctl(["kill", "SIGTERM", serviceDomain()]);
  return serviceStatus();
}

export function restartService() {
  requireMacOS();
  if (!serviceStatus().loaded) throw new Error("service is not loaded; run `photon-codex service start`");
  runLaunchctl(["kickstart", "-k", serviceDomain()]);
  return serviceStatus();
}

export async function uninstallService() {
  requireMacOS();
  runLaunchctl(["bootout", serviceDomain()], { allowFailure: true });
  try {
    await unlink(servicePlistPath());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return serviceStatus();
}

export function serviceStatus(env = process.env) {
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false };
  const result = spawnSync("launchctl", ["print", serviceDomain()], { encoding: "utf8" });
  const state = result.stdout?.match(/^\s*state = (.+)$/m)?.[1]?.trim() || null;
  const pid = Number(result.stdout?.match(/^\s*pid = (\d+)$/m)?.[1] || 0) || null;
  return {
    supported: true,
    installed: existsSync(servicePlistPath()),
    loaded: result.status === 0,
    running: state === "running",
    state,
    pid,
    label: SERVICE_LABEL,
    plist: servicePlistPath(),
    log: runtimeLogPath(env),
  };
}

export function launchAgentPlist(env = process.env) {
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const pathValue = env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(cliPath)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
    <key>PHOTON_CODEX_HOME</key>
    <string>${xml(appHome(env))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} failed`).trim());
  }
  return result;
}

function userDomain() {
  return `gui/${process.getuid()}`;
}

function serviceDomain() {
  return `${userDomain()}/${SERVICE_LABEL}`;
}

function requireMacOS() {
  if (process.platform !== "darwin") throw new Error("the managed service is available on macOS only");
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
