#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Bridge } from "./bridge.js";
import {
  loadConfig,
  loadState,
  readProjectSecret,
  redactConfig,
  saveConfig,
  setProjectSecret,
} from "./config.js";

const [command = "help", ...args] = process.argv.slice(2);

try {
  if (command === "init") await init(args);
  else if (command === "auth" && args[0] === "set") await authSet();
  else if (command === "run") await run();
  else if (command === "doctor") await doctor();
  else if (command === "status") print(await control("status"));
  else if (command === "stop") print(await control("stop"));
  else if (command === "send") print(await control("send", { text: args.join(" ") }));
  else if (command === "reply") print(await control("reply", { messageId: args[0], text: args.slice(1).join(" ") }));
  else if (command === "react") print(await control("react", { messageId: args[0], emoji: args[1] }));
  else if (command === "thread" && args[0] === "new") print(await control("thread-new"));
  else help(command === "help" ? 0 : 1);
} catch (error) {
  process.stderr.write(`photon-codex: ${error.message}\n`);
  process.exitCode = 1;
}

async function init(args) {
  const flags = parseFlags(args);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const projectId = flags["project-id"] || await rl.question("Photon project ID: ");
    const allowedSender = flags.sender || await rl.question("Your allowed phone number (E.164): ");
    const cwd = flags.cwd || await rl.question(`Codex workspace [${process.cwd()}]: `) || process.cwd();
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
  try {
    await bridge.run();
  } catch (error) {
    await bridge.stop().catch(() => {});
    throw error;
  }
}

async function doctor() {
  const checks = [];
  let config;
  try {
    config = await loadConfig();
    checks.push({ check: "config", ok: true, value: redactConfig(config) });
  } catch (error) {
    checks.push({ check: "config", ok: false, error: error.message });
  }
  const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
  checks.push({ check: "codex", ok: codex.status === 0, value: codex.stdout.trim() || undefined });
  if (config) {
    try {
      readProjectSecret(config.projectId);
      checks.push({ check: "photon-auth", ok: true });
    } catch (error) {
      checks.push({ check: "photon-auth", ok: false, error: error.message });
    }
  }
  const ok = checks.every((check) => check.ok);
  print({ ok, checks });
  if (!ok) process.exitCode = 1;
}

async function control(command, body = {}) {
  const state = await loadState();
  if (!state.control?.port || !state.control?.token) {
    if (command === "status") return { running: false, threadId: state.threadId, spaceBound: Boolean(state.spaceId) };
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
      if (command === "status" && error.code === "ECONNREFUSED") resolve({ running: false, threadId: state.threadId, spaceBound: Boolean(state.spaceId) });
      else reject(error);
    });
  });
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

function help(exitCode) {
  stdout.write(`photon-codex

  init [--project-id ID --sender +1555… --cwd PATH]
  auth set
  doctor
  run
  status
  stop
  send TEXT
  reply MESSAGE_ID TEXT
  react MESSAGE_ID EMOJI
  thread new
`);
  process.exitCode = exitCode;
}
