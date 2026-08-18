import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Spectrum, markdown } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { attachmentsPath, loadState, saveState } from "./config.js";
import { CodexAppServer } from "./codex.js";
import { logEvent } from "./log.js";

const USER_CONTENT_TYPES = new Set(["text", "markdown", "attachment", "voice", "reaction"]);

export class Bridge {
  constructor({ config, projectSecret, env = process.env, logger = logEvent }) {
    this.config = config;
    this.projectSecret = projectSecret;
    this.env = env;
    this.logger = logger;
    this.state = null;
    this.spectrum = null;
    this.provider = null;
    this.space = null;
    this.codex = null;
    this.controlServer = null;
    this.activeTurnId = null;
    this.finalByTurn = new Map();
    this.targetByTurn = new Map();
    this.stopping = false;
    this.runtimeError = null;
    this.stateWrite = Promise.resolve();
  }

  async run() {
    this.state = await loadState(this.env);
    await this.#updateState((state) => {
      state.control = null;
      state.runtime.startedAt = new Date().toISOString();
      state.runtime.stoppedAt = null;
      state.runtime.lastError = null;
      state.runtime.lastErrorAt = null;
    });
    await this.logger("info", "bridge_starting", {}, this.env);
    this.spectrum = await Spectrum({
      projectId: this.config.projectId,
      projectSecret: this.projectSecret,
      providers: [imessage.config()],
      telemetry: false,
      options: { flattenGroups: true, logLevel: "warn" },
    });
    this.provider = imessage(this.spectrum);
    if (this.state.spaceId) {
      try {
        this.space = await this.provider.space.get(this.state.spaceId);
      } catch {
        this.space = null;
      }
    }
    this.codex = new CodexAppServer({
      cwd: this.config.cwd,
      threadId: this.state.threadId,
      onThreadId: async (threadId) => {
        await this.#updateState((state) => { state.threadId = threadId; });
      },
    });
    this.codex.on("notification", (method, params) => {
      void this.handleCodexNotification(method, params).catch((error) => {
        process.stderr.write(`Codex event ${method} failed: ${error.message}\n`);
        void this.#recordError("codex_notification_failed", error, { method });
      });
    });
    this.codex.on("exit", (error) => {
      if (this.stopping) return;
      this.runtimeError = error;
      void this.spectrum?.stop();
    });
    await this.codex.start();
    await this.#startControlServer();
    await this.logger("info", "bridge_ready", {
      serviceTier: this.codex.serviceTier,
      threadBound: Boolean(this.codex.threadId),
    }, this.env);
    process.stdout.write(`photon-codex ready · thread ${this.codex.threadId}\n`);
    for await (const [space, message] of this.spectrum.messages) {
      await this.handleMessage(space, message);
    }
    if (!this.stopping) throw this.runtimeError || new Error("Photon message stream ended unexpectedly");
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.state) {
      await this.#updateState((state) => {
        state.control = null;
        state.runtime.stoppedAt = new Date().toISOString();
      });
    }
    await new Promise((resolve) => this.controlServer?.close(resolve) || resolve());
    await this.codex?.stop();
    await this.spectrum?.stop();
    await this.logger("info", "bridge_stopped", {}, this.env);
  }

  async handleMessage(space, message) {
    const disposition = messageDisposition(space, message, this.config, this.state);
    if (!disposition.accept) {
      if (disposition.record && !this.state.ignoredEventIds.includes(message.id)) {
        await this.#updateState((state) => {
          state.ignoredEventIds.push(message.id);
          state.runtime.ignoredEvents += 1;
          state.runtime.lastEventAt = new Date().toISOString();
        });
        await this.logger("info", "event_ignored", { contentType: disposition.contentType }, this.env);
      }
      return;
    }

    if (!this.state.spaceId) {
      this.space = space;
      await this.#updateState((state) => { state.spaceId = space.id; });
    }

    const input = await this.#inputFor(message);
    try {
      await message.read().catch(() => {});
      await space.startTyping().catch(() => {});
      if (this.activeTurnId) {
        try {
          await this.codex.steer(this.activeTurnId, input);
          this.targetByTurn.set(this.activeTurnId, message);
        } catch {
          this.activeTurnId = null;
          await this.#startTurn(input, message);
        }
      } else {
        await this.#startTurn(input, message);
      }
      await this.#updateState((state) => {
        state.acceptedMessageIds.push(message.id);
        state.runtime.acceptedMessages += 1;
        state.runtime.lastEventAt = new Date().toISOString();
      });
      await this.logger("info", "message_accepted", { contentType: disposition.contentType }, this.env);
    } catch (error) {
      await space.stopTyping().catch(() => {});
      process.stderr.write(`message ${message.id} failed: ${error.message}\n`);
      await this.#recordError("message_failed", error, { contentType: disposition.contentType });
    }
  }

  async #startTurn(input, message) {
    const result = await this.codex.startTurn(input);
    const turnId = result.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn ID");
    this.activeTurnId = turnId;
    this.targetByTurn.set(turnId, message);
  }

  async #inputFor(message) {
    const content = message.content;
    const header = `[Photon iMessage]\nmessage_id: ${message.id}\ntimestamp: ${message.timestamp.toISOString()}\n`;
    if (content.type === "text") {
      return [textInput(`${header}\n${content.text}`)];
    }
    if (content.type === "markdown") {
      return [textInput(`${header}\n${content.markdown}`)];
    }
    if (content.type === "attachment" || content.type === "voice") {
      const file = await this.#saveInboundFile(message.id, content);
      const description = `${header}\nReceived ${content.type}: ${file}\nMIME type: ${content.mimeType}${content.duration ? `\nDuration: ${content.duration}s` : ""}`;
      if (content.mimeType.startsWith("image/")) {
        return [textInput(description), { type: "localImage", path: file }];
      }
      return [textInput(description)];
    }
    if (content.type === "reaction") {
      return [textInput(`${header}\nReaction: ${content.emoji}\nTarget message: ${content.target?.id || "unknown"}`)];
    }
    throw new Error(`unsupported content type: ${content.type || "unknown"}`);
  }

  async #saveInboundFile(messageId, content) {
    if (content.size && content.size > this.config.maxAttachmentBytes) {
      throw new Error(`attachment exceeds ${this.config.maxAttachmentBytes} bytes`);
    }
    const dir = path.join(attachmentsPath(this.env), safeName(messageId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, safeName(content.name || `${content.type}-${content.id || messageId}`));
    const bytes = await content.read();
    if (bytes.byteLength > this.config.maxAttachmentBytes) {
      throw new Error(`attachment exceeds ${this.config.maxAttachmentBytes} bytes`);
    }
    await writeFile(file, bytes, { mode: 0o600 });
    return file;
  }

  async handleCodexNotification(method, params) {
    if (method === "turn/started") {
      this.activeTurnId = params.turn?.id || this.activeTurnId;
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      if (params.item.phase === "final_answer" || !this.finalByTurn.has(params.turnId)) {
        this.finalByTurn.set(params.turnId, params.item.text?.trim() || "");
      }
      return;
    }
    if (method !== "turn/completed") return;
    const turnId = params.turn?.id || this.activeTurnId;
    const target = this.targetByTurn.get(turnId);
    const final = this.finalByTurn.get(turnId) || finalFromTurn(params.turn);
    this.activeTurnId = null;
    this.targetByTurn.delete(turnId);
    this.finalByTurn.delete(turnId);
    await this.space?.stopTyping().catch(() => {});
    if (!target) return;
    if (params.turn?.status === "completed" && final) {
      const chunks = splitMessage(stripInternal(final));
      if (chunks.length) await retryTransient(() => target.reply(markdown(chunks[0])));
      for (const chunk of chunks.slice(1)) await retryTransient(() => target.space.send(markdown(chunk)));
      await this.#recordReply(target.id);
      return;
    }
    await retryTransient(() => target.reply("I could not finish that Codex turn. Please try again."));
    await this.#recordReply(target.id);
  }

  async #startControlServer() {
    const token = randomBytes(24).toString("base64url");
    this.controlServer = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        void this.#handleControl(line).then(
          (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
          (error) => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`),
        );
      });
    });
    await new Promise((resolve, reject) => {
      this.controlServer.once("error", reject);
      this.controlServer.listen(0, "127.0.0.1", resolve);
    });
    const address = this.controlServer.address();
    this.controlToken = token;
    await this.#updateState((state) => {
      state.control = { port: address.port, token, pid: process.pid };
    });
  }

  async #handleControl(line) {
    const request = JSON.parse(line);
    if (request.token !== this.controlToken) throw new Error("unauthorized");
    if (request.command === "status") return this.status();
    if (request.command === "stop") {
      setImmediate(() => void this.stop().then(() => process.exit(0)));
      return { stopping: true };
    }
    if (request.command === "thread-new") {
      if (this.activeTurnId) throw new Error("a Codex turn is active");
      const threadId = await this.codex.newThread();
      return { threadId };
    }
    const space = await this.#ensureSpace();
    if (request.command === "send") {
      const sent = await space.send(markdown(requiredText(request.text)));
      return { messageId: sent?.id || null };
    }
    const message = await space.getMessage(requiredText(request.messageId));
    if (!message) throw new Error("message not found");
    if (request.command === "reply") {
      const sent = await message.reply(markdown(requiredText(request.text)));
      return { messageId: sent?.id || null };
    }
    if (request.command === "react") {
      const sent = await message.react(requiredText(request.emoji));
      return { messageId: sent?.id || null };
    }
    throw new Error(`unknown command: ${request.command}`);
  }

  async #ensureSpace() {
    if (this.space) return this.space;
    if (!this.state.spaceId) throw new Error("No iMessage conversation is bound yet. Send the Photon line a message first.");
    this.space = await this.provider.space.get(this.state.spaceId);
    return this.space;
  }

  status() {
    return {
      running: true,
      pid: process.pid,
      threadId: this.codex?.threadId || this.state.threadId,
      serviceTier: this.codex?.serviceTier,
      priority: this.codex?.serviceTier === "priority",
      spaceBound: Boolean(this.state.spaceId),
      activeTurnId: this.activeTurnId,
      acceptedMessages: this.state.runtime.acceptedMessages,
      repliesSent: this.state.runtime.repliesSent,
      repliesFailed: this.state.runtime.repliesFailed,
      ignoredEvents: this.state.runtime.ignoredEvents,
      startedAt: this.state.runtime.startedAt,
      lastEventAt: this.state.runtime.lastEventAt,
      lastReplyAt: this.state.runtime.lastReplyAt,
      lastError: this.state.runtime.lastError,
      cwd: this.config.cwd,
    };
  }

  async #recordReply(messageId) {
    await this.#updateState((state) => {
      state.repliedMessageIds.push(messageId);
      state.runtime.repliesSent += 1;
      state.runtime.lastReplyAt = new Date().toISOString();
      state.runtime.lastError = null;
      state.runtime.lastErrorAt = null;
    });
    await this.logger("info", "reply_sent", {}, this.env);
  }

  async #recordError(event, error, details = {}) {
    const message = cleanError(error);
    if (this.state) {
      await this.#updateState((state) => {
        state.runtime.lastError = message;
        state.runtime.lastErrorAt = new Date().toISOString();
        if (event === "codex_notification_failed" && details.method === "turn/completed") state.runtime.repliesFailed += 1;
      });
    }
    await this.logger("error", event, { ...details, error: message }, this.env);
  }

  async #updateState(update) {
    this.stateWrite = this.stateWrite.then(async () => {
      update(this.state);
      this.state = await saveState(this.state, this.env);
      return this.state;
    });
    return this.stateWrite;
  }
}

export function messageDisposition(space, message, config, state) {
  if (message?.direction !== "inbound") return { accept: false, reason: "direction" };
  if (space?.type !== "dm") return { accept: false, reason: "space" };
  if (normalizePhone(message.sender?.id) !== config.allowedSender) return { accept: false, reason: "sender" };
  if (state.spaceId && space.id !== state.spaceId) return { accept: false, reason: "conversation" };
  if (state.acceptedMessageIds.includes(message.id)) return { accept: false, reason: "duplicate" };
  const contentType = message.content?.type || "unknown";
  if (!USER_CONTENT_TYPES.has(contentType)) {
    return { accept: false, reason: "event", record: true, contentType };
  }
  return { accept: true, contentType };
}

export function normalizePhone(value) {
  return String(value || "").replace(/[\s()-]/g, "");
}

export function safeName(value) {
  const clean = String(value || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return clean.slice(0, 160) || "file";
}

export function splitMessage(text, limit = 4000) {
  const output = [];
  let rest = String(text || "").trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    output.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) output.push(rest);
  return output;
}

function textInput(text) {
  return { type: "text", text, text_elements: [] };
}

function finalFromTurn(turn) {
  return [...(turn?.items || [])].reverse().find((item) => item.type === "agentMessage")?.text?.trim() || "";
}

function stripInternal(text) {
  return text.replace(/\n?<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/i, "").trim();
}

function requiredText(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("value is required");
  return text;
}

async function retryTransient(action) {
  const delays = [0, 250, 1000];
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isTransient(error)) break;
    }
  }
  throw lastError;
}

function isTransient(error) {
  return /(?:ECONNRESET|ETIMEDOUT|fetch failed|network|temporar|unavailable|rate.?limit|\b429\b|timeout)/i.test(error?.message || "");
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}
