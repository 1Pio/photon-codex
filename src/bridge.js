import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Spectrum, markdown } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { attachmentsPath, loadState, saveState } from "./config.js";
import { CodexAppServer } from "./codex.js";

export class Bridge {
  constructor({ config, projectSecret, env = process.env }) {
    this.config = config;
    this.projectSecret = projectSecret;
    this.env = env;
    this.state = null;
    this.spectrum = null;
    this.provider = null;
    this.space = null;
    this.codex = null;
    this.controlServer = null;
    this.activeTurnId = null;
    this.finalByTurn = new Map();
    this.targetByTurn = new Map();
  }

  async run() {
    this.state = await loadState(this.env);
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
        this.state.threadId = threadId;
        await saveState(this.state, this.env);
      },
    });
    this.codex.on("notification", (method, params) => {
      void this.#onCodexNotification(method, params).catch((error) => {
        process.stderr.write(`Codex event ${method} failed: ${error.message}\n`);
      });
    });
    await this.codex.start();
    await this.#startControlServer();
    process.stdout.write(`photon-codex ready · thread ${this.codex.threadId}\n`);
    for await (const [space, message] of this.spectrum.messages) {
      await this.#onMessage(space, message);
    }
  }

  async stop() {
    if (this.state) {
      this.state.control = null;
      await saveState(this.state, this.env);
    }
    await new Promise((resolve) => this.controlServer?.close(resolve) || resolve());
    await this.codex?.stop();
    await this.spectrum?.stop();
  }

  async #onMessage(space, message) {
    if (message.direction !== "inbound") return;
    if (space.type !== "dm") return;
    if (normalizePhone(message.sender?.id) !== this.config.allowedSender) return;
    if (this.state.spaceId && space.id !== this.state.spaceId) return;
    if (this.state.seenMessageIds.includes(message.id)) return;

    if (!this.state.spaceId) {
      this.state.spaceId = space.id;
      this.space = space;
      await saveState(this.state, this.env);
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
      this.state.seenMessageIds.push(message.id);
      await saveState(this.state, this.env);
    } catch (error) {
      await space.stopTyping().catch(() => {});
      process.stderr.write(`message ${message.id} failed: ${error.message}\n`);
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
    return [textInput(`${header}\nReceived content:\n${safeJson(content)}`)];
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

  async #onCodexNotification(method, params) {
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
      if (chunks.length) await target.reply(markdown(chunks[0]));
      for (const chunk of chunks.slice(1)) await target.space.send(markdown(chunk));
      return;
    }
    await target.reply("I could not finish that Codex turn. Please try again.");
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
    this.state.control = { port: address.port, token, pid: process.pid };
    this.controlToken = token;
    await saveState(this.state, this.env);
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
      spaceBound: Boolean(this.state.spaceId),
      activeTurnId: this.activeTurnId,
      seenMessages: this.state.seenMessageIds.length,
      cwd: this.config.cwd,
    };
  }
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

function safeJson(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === "function" ? undefined : item), 2);
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
