#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Bridge } from "./bridge.js";
import { CodexAppServer, codexExecutable, codexHome } from "./codex.js";
import {
  loadConfig,
  loadState,
  readProjectSecret,
  redactConfig,
  runtimeLogPath,
  saveConfig,
  saveState,
  setProjectSecret,
  workspacePath,
} from "./config.js";
import { logEvent } from "./log.js";
import {
  installService,
  restartService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from "./service.js";

const [command = "help", ...args] = process.argv.slice(2);

try {
  if (command === "init") await init(args);
  else if (command === "auth" && args[0] === "set") await authSet();
  else if (command === "run") await run();
  else if (command === "doctor") await doctor();
  else if (command === "status") print({ ...(await control("status")), service: serviceStatus() });
  else if (command === "stop") print(await control("stop"));
  else if (command === "send") print(await control("send", { text: args.join(" ") }));
  else if (command === "send-file") await sendFile(args);
  else if (command === "reply") print(await control("reply", { messageId: args[0], text: args.slice(1).join(" ") }));
  else if (command === "react") print(await control("react", { messageId: args[0], emoji: args[1] }));
  else if (command === "thread" && args[0] === "new") print(await control("thread-new"));
  else if (command === "logs") print(await readLogs(args[0]));
  else if (command === "workspace" && args[0] === "set") await workspaceSet(args.slice(1));
  else if (command === "service" && args[0] === "install") await serviceInstall();
  else if (command === "service" && args[0] === "start") print(await startService());
  else if (command === "service" && args[0] === "stop") print(stopService());
  else if (command === "service" && args[0] === "restart") print(restartService());
  else if (command === "service" && args[0] === "status") print({ ...serviceStatus(), bridge: await control("status") });
  else if (command === "service" && args[0] === "uninstall") print(await uninstallService());
  else help(command === "help" || command === "--help" || command === "-h" ? 0 : 1);
} catch (error) {
  await logEvent("error", "cli_failed", { command, error: error.message });
  process.stderr.write(`photon-codex: ${error.message}\n`);
  process.exitCode = 1;
}

async function init(args) {
  const flags = parseFlags(args);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const projectId = flags["project-id"] || await rl.question("Photon project ID: ");
    const allowedSender = flags.sender || await rl.question("Your allowed phone number (E.164): ");
    const defaultWorkspace = workspacePath();
    const cwd = flags.cwd || await rl.question(`Codex workspace [${defaultWorkspace}]: `) || defaultWorkspace;
    await mkdir(path.resolve(cwd), { recursive: true, mode: 0o700 });
    const config = await saveConfig({ projectId, allowedSender, cwd: path.resolve(cwd) });
    print({ configured: true, config: redactConfig(config) });
    if (process.platform === "darwin") stdout.write("Next: photon-codex auth set\n");
    else stdout.write("Next: set PHOTON_PROJECT_SECRET, then run photon-codex doctor\n");
  } finally {
    rl.close();
  }
}

async function authSet() {
  const config = await loadConfig();
  setProjectSecret(config.projectId);
  stdout.write("Photon secret saved in macOS Keychain.\n");
}

async function run() {
  const config = await loadConfig();
  await mkdir(config.cwd, { recursive: true, mode: 0o700 });
  const projectSecret = readProjectSecret(config.projectId);
  const bridge = new Bridge({ config, projectSecret });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("SIGHUP", () => void stop());
  try {
    await bridge.run();
  } catch (error) {
    await bridge.stop().catch(() => {});
    throw error;
  }
}

async function doctor() {
  const result = await doctorResult();
  print(result);
  if (!result.ok) process.exitCode = 1;
}

async function doctorResult() {
  const checks = [];
  let config;
  try {
    config = await loadConfig();
    checks.push({ check: "config", ok: true, value: redactConfig(config) });
  } catch (error) {
    checks.push({ check: "config", ok: false, error: error.message });
  }
  const executable = codexExecutable();
  const codex = spawnSync(executable, ["--version"], { encoding: "utf8" });
  checks.push({
    check: "codex",
    ok: codex.status === 0,
    value: codex.status === 0 ? { executable, home: codexHome(), version: codex.stdout.trim() } : undefined,
  });
  if (config) {
    try {
      await mkdir(config.cwd, { recursive: true, mode: 0o700 });
      checks.push({ check: "workspace", ok: true, value: config.cwd });
    } catch (error) {
      checks.push({ check: "workspace", ok: false, error: error.message });
    }
    try {
      readProjectSecret(config.projectId);
      checks.push({ check: "photon-auth", ok: true });
    } catch (error) {
      checks.push({ check: "photon-auth", ok: false, error: error.message });
    }
    if (codex.status === 0) {
      const probe = new CodexAppServer({
        cwd: config.cwd,
        ephemeral: true,
        onThreadId: async () => {},
      });
      try {
        await probe.start();
        const parity = probe.parityReport();
        checks.push({ check: "codex-config-parity", ok: parity.inherited, value: parity });
        checks.push({ check: "codex-auth", ok: probe.account.authenticated, value: probe.account });
        const capabilities = await capabilityInventory(probe, config.cwd);
        checks.push({ check: "codex-capabilities", ok: capabilities.ok, value: capabilities });
        const smoke = await smokeTurn(probe);
        checks.push({ check: "codex-live-turn", ok: smoke.ok, value: smoke });
      } catch (error) {
        checks.push({ check: "codex-config-parity", ok: false, error: error.message });
      } finally {
        await probe.stop().catch(() => {});
      }
    }
  }
  const ok = checks.every((check) => check.ok);
  return { ok, checks };
}

async function capabilityInventory(codex, cwd) {
  const [skills, mcp, apps] = await Promise.all([
    codex.request("skills/list", { cwds: [cwd], forceReload: false }),
    codex.request("mcpServerStatus/list", { threadId: codex.threadId, limit: 100, detail: "toolsAndAuthOnly" }),
    codex.request("app/list", { threadId: codex.threadId, limit: 100, forceRefetch: false }),
  ]);
  const skillEntries = skills.data || [];
  const mcpServers = mcp.data || [];
  const appEntries = apps.data || [];
  const errors = skillEntries.flatMap((entry) => entry.errors || []);
  return {
    ok: errors.length === 0,
    skills: skillEntries.reduce((count, entry) => count + (entry.skills?.length || 0), 0),
    skillErrors: errors.length,
    mcpServers: mcpServers.length,
    mcpTools: mcpServers.reduce((count, server) => count + Object.keys(server.tools || {}).length, 0),
    apps: appEntries.length,
    enabledApps: appEntries.filter((app) => app.isEnabled).length,
    accessibleApps: appEntries.filter((app) => app.isAccessible).length,
  };
}

async function smokeTurn(codex) {
  let shellUsed = false;
  let final = "";
  let serverRequest = null;
  let timeout;
  const completed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Codex live turn timed out")), 90_000);
    codex.on("notification", function onNotification(method, params) {
      if (method === "item/completed" && params.item?.type === "commandExecution" && params.item.status === "completed") {
        shellUsed = true;
      }
      if (method === "item/completed" && params.item?.type === "agentMessage") {
        final = params.item.text?.trim() || final;
      }
      if (method === "turn/completed") resolve(params.turn);
    });
    codex.on("request", function onRequest(request) {
      serverRequest = request.method;
      codex.reject(request.id, "Doctor cannot answer an interactive request");
    });
  });
  try {
    await codex.startTurn([{
      type: "text",
      text: "Run `pwd` using the shell tool. Then reply with exactly PHOTON_CODEX_PARITY_OK and nothing else.",
      text_elements: [],
    }]);
    const turn = await completed;
    return {
      ok: turn?.status === "completed" && shellUsed && final === "PHOTON_CODEX_PARITY_OK" && !serverRequest,
      status: turn?.status || null,
      shellUsed,
      exactReply: final === "PHOTON_CODEX_PARITY_OK",
      interactiveRequest: serverRequest,
    };
  } finally {
    clearTimeout(timeout);
    codex.removeAllListeners("notification");
    codex.removeAllListeners("request");
  }
}

async function workspaceSet(args) {
  const cwd = path.resolve(requiredText(args.join(" ")));
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const config = await loadConfig();
  const saved = await saveConfig({ ...config, cwd });
  const state = await loadState();
  state.threadId = null;
  await saveState(state);
  print({ configured: true, restartRequired: true, config: redactConfig(saved) });
}

async function sendFile(args) {
  const file = path.resolve(requiredText(args[0]));
  const mimeType = args[1] || "application/octet-stream";
  print(await control("send-file", { file, mimeType, name: path.basename(file) }));
}

async function serviceInstall() {
  const result = await doctorResult();
  if (!result.ok) throw new Error(`preflight failed: ${result.checks.filter((check) => !check.ok).map((check) => check.check).join(", ")}`);
  print({ ...(await installService()), preflight: result });
}

async function readLogs(limitValue) {
  const limit = Math.min(Math.max(Number(limitValue || 50), 1), 500);
  let text;
  try {
    text = await readFile(runtimeLogPath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { entries: [] };
    throw error;
  }
  const entries = text.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  return { entries };
}

async function control(command, body = {}) {
  const state = await loadState();
  const staleControl = Boolean(state.control && !pidAlive(state.control.pid));
  if (!state.control?.port || !state.control?.token || staleControl) {
    if (command === "status") return offlineStatus(state, staleControl);
    throw new Error("bridge is not running");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: state.control.port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3000, () => socket.destroy(new Error("control request timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: state.control.token, command, ...body })}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(response);
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      if (command === "status" && ["ECONNREFUSED", "ECONNRESET"].includes(error.code)) resolve(offlineStatus(state, true));
      else reject(error);
    });
  });
}

function offlineStatus(state, staleControl = false) {
  return {
    running: false,
    staleControl,
    threadId: state.threadId,
    spaceBound: Boolean(state.spaceId),
    acceptedMessages: state.runtime.acceptedMessages,
    repliesSent: state.runtime.repliesSent,
    repliesFailed: state.runtime.repliesFailed,
    ignoredEvents: state.runtime.ignoredEvents,
    lastEventAt: state.runtime.lastEventAt,
    lastReplyAt: state.runtime.lastReplyAt,
    lastError: state.runtime.lastError,
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) continue;
    flags[item.slice(2)] = args[index + 1];
    index += 1;
  }
  return flags;
}

function print(value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredText(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("value is required");
  return text;
}

function help(exitCode) {
  stdout.write(`photon-codex

  init [--project-id ID --sender +1555… --cwd PATH]
  auth set
  doctor
  run
  status
  stop
  send TEXT
  send-file PATH [MIME_TYPE]
  reply MESSAGE_ID TEXT
  react MESSAGE_ID EMOJI
  thread new
  workspace set PATH
  logs [COUNT]
  service install|start|stop|restart|status|uninstall
`);
  process.exitCode = exitCode;
}
