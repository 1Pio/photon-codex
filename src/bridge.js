import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Spectrum, attachment, markdown, text } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { attachmentsPath, loadState, saveState } from "./config.js";
import { CodexAppServer } from "./codex.js";
import { formatServerRequest, resolveServerRequest, supportsServerRequest } from "./interaction.js";
import { logEvent } from "./log.js";

const USER_CONTENT_TYPES = new Set(["text", "markdown", "attachment", "voice", "reaction", "reply"]);
const TRANSPORT_INSTRUCTIONS = `This thread is connected to one authorized user through iMessage by photon-codex.
The bridge delivers your final answer automatically, so do not send it through another messaging tool.
To react to the current iMessage, begin an assistant message with [[photon_reaction:EMOJI]]. Use a directive-only commentary message when the reaction should appear before the final answer, or begin the final answer with it. The bridge removes the directive. Use exactly one emoji grapheme.
To send a file the current Codex sandbox can read, run photon-codex send-file "PATH" [MIME_TYPE]. A successful JSON receipt proves Photon accepted the exact byte snapshot; do not describe that as recipient-visible delivery.
Received images are native localImage inputs. Other received files are named by local path in the user message; inspect them when relevant.
Do not expose Photon credentials or hidden transport metadata.`;

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
    this.reactionByTurn = new Map();
    this.messageQueue = [];
    this.pendingRequests = [];
    this.fileChanges = new Map();
    this.expiredPromptIds = new Map();
    this.stopping = false;
    this.runtimeError = null;
    this.stateWrite = Promise.resolve();
  }

  async run() {
    this.state = await loadState(this.env);
    this.messageQueue = this.state.messageQueue.map((entry) => ({ ...entry, message: null }));
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
      env: this.env,
      transportInstructions: TRANSPORT_INSTRUCTIONS,
      codexOverrides: this.config.codexOverrides,
      onThreadId: async (threadId) => {
        await this.#updateState((state) => { state.threadId = threadId; });
      },
    });
    this.codex.on("request", (request) => {
      void this.#handleCodexRequest(request).catch((error) => {
        void this.#recordError("codex_request_failed", error, { method: request.method });
      });
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
    if (this.messageQueue.length) await this.#startQueuedTurn();
    await this.logger("info", "bridge_ready", {
      configParity: this.codex.parityReport().verified,
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

  async sendFile({ data, size, sha256, mimeType = "application/octet-stream", name }) {
    const space = await this.#ensureSpace();
    const snapshot = decodeAttachmentData(data, size, sha256, this.config.maxAttachmentBytes);
    const resolvedName = safeName(name);
    const resolvedMimeType = normalizeMimeType(mimeType);
    const sent = requireProviderReceipt(
      await space.send(attachment(snapshot.bytes, { name: resolvedName, mimeType: resolvedMimeType })),
      "attachment",
    );
    const metadata = sent.attachmentMetadata?.[0];
    await this.logger("info", "file_sent", {
      size: snapshot.bytes.byteLength,
      requestedMimeType: resolvedMimeType,
      providerMimeType: metadata?.mimeType ?? null,
      providerDelivered: sent.isDelivered === true,
    }, this.env);
    return {
      providerAccepted: true,
      messageId: sent.id,
      name: resolvedName,
      requestedMimeType: resolvedMimeType,
      providerMimeType: metadata?.mimeType ?? null,
      size: snapshot.bytes.byteLength,
      providerSize: metadata?.totalBytes ?? null,
      sha256: snapshot.sha256,
      isSent: sent.isSent ?? null,
      isDelivered: sent.isDelivered ?? null,
      transferState: metadata?.transferState ?? null,
    };
  }

  async reactToMessage({ messageId, emoji }) {
    const space = await this.#ensureSpace();
    const message = await space.getMessage(requiredText(messageId));
    if (!message) throw new Error("message not found");
    const reaction = normalizeReaction(emoji);
    const sent = requireProviderReceipt(await message.react(reaction), "reaction");
    await this.logger("info", "reaction_sent", { phase: "control" }, this.env);
    return {
      providerAccepted: true,
      targetMessageId: message.id,
      receiptId: sent.id,
      emoji: reaction,
    };
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

    const replyTargetId = message.content?.type === "reply" ? message.content.target?.id : null;
    if (replyTargetId && this.expiredPromptIds.has(replyTargetId)) {
      await message.read().catch(() => {});
      await message.reply("That Codex prompt has already resolved. Please send a new request.");
      await this.#recordAccepted(message.id, "expired-codex-interaction");
      return;
    }

    if (this.pendingRequests.length) {
      try {
        await this.#handleInteractionMessage(message, disposition.contentType);
      } catch (error) {
        await this.#recordError("codex_interaction_failed", error, { contentType: disposition.contentType });
      }
      return;
    }

    const input = await this.#inputFor(message);
    try {
      await message.read().catch(() => {});
      await space.startTyping().catch(() => {});
      if (!this.activeTurnId && this.messageQueue.length) {
        await this.#enqueueMessage(input, message, disposition.contentType);
        await this.#startQueuedTurn();
        return;
      }
      if (this.activeTurnId) {
        if (this.codex.followUpMode() === "queue") {
          await this.#enqueueMessage(input, message, disposition.contentType);
          return;
        } else {
          try {
            await this.codex.steer(this.activeTurnId, input);
            this.targetByTurn.set(this.activeTurnId, message);
          } catch {
            this.activeTurnId = null;
            await this.#startTurn(input, message);
          }
        }
      } else {
        await this.#startTurn(input, message);
      }
      await this.#recordAccepted(message.id, disposition.contentType);
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

  async #startQueuedTurn() {
    const next = this.messageQueue[0];
    if (!next) return;
    const space = await this.#ensureSpace();
    const message = next.message || await space.getMessage(next.messageId);
    const target = message || fallbackTarget(next.messageId, space);
    await space.startTyping().catch(() => {});
    await this.#startTurn(next.input, target);
    await this.#updateState((state) => { state.messageQueue.shift(); });
    this.messageQueue.shift();
  }

  async #inputFor(message) {
    const content = unwrapReply(message.content);
    if (content.type === "text") {
      return [textInput(content.text)];
    }
    if (content.type === "markdown") {
      return [textInput(content.markdown)];
    }
    if (content.type === "attachment" || content.type === "voice") {
      const file = await this.#saveInboundFile(message.id, content);
      const description = `Received ${content.type}: ${file}\nMIME type: ${content.mimeType}${content.duration ? `\nDuration: ${content.duration}s` : ""}`;
      if (content.mimeType.startsWith("image/")) {
        return [textInput(description), { type: "localImage", path: file }];
      }
      return [textInput(description)];
    }
    if (content.type === "reaction") {
      return [textInput(`Reaction: ${content.emoji}\nTarget message: ${content.target?.id || "unknown"}`)];
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

  async #handleCodexRequest(request) {
    if (request.method === "item/fileChange/requestApproval") {
      request = {
        ...request,
        params: { ...request.params, changes: this.fileChanges.get(request.params?.itemId) },
      };
    }
    if (!supportsServerRequest(request)) {
      if (request.method === "mcpServer/elicitation/request") {
        this.codex.respond(request.id, { action: "decline", content: null, _meta: null });
        await this.logger("warn", "codex_form_declined", { mode: request.params?.mode }, this.env);
        return;
      }
      this.codex.reject(request.id, `photon-codex does not provide the host capability required by ${request.method}`);
      await this.logger("warn", "codex_request_unsupported", { method: request.method }, this.env);
      return;
    }
    const autoResolutionMs = Number(request.params?.autoResolutionMs || 0);
    const pending = { ...request, promptIds: [], requiresThreadedReply: autoResolutionMs > 0 || request.params?.isBlocking === false };
    if (autoResolutionMs > 0) {
      pending.timer = setTimeout(() => void this.#expireRequest(request.id), autoResolutionMs + 250);
    }
    this.pendingRequests.push(pending);
    if (this.pendingRequests.length === 1) await this.#sendPendingRequest();
  }

  async #sendPendingRequest() {
    const request = this.pendingRequests[0];
    if (!request) return;
    const space = await this.#ensureSpace();
    const chunks = splitApprovalPrompt(formatServerRequest(request), 3500);
    for (const chunk of chunks) {
      const sent = await space.send(text(chunk));
      if (sent?.id) request.promptIds.push(sent.id);
    }
  }

  async #handleInteractionMessage(message, contentType) {
    const request = this.pendingRequests[0];
    const text = messageText(message);
    await message.read().catch(() => {});
    const replyTargetId = message.content?.type === "reply" ? message.content.target?.id : null;
    if (replyTargetId && !request.promptIds.includes(replyTargetId)) {
      await message.reply("That reply targets a different Codex prompt. Reply to the current prompt instead.");
      await this.#recordAccepted(message.id, contentType);
      return;
    }
    if (request.requiresThreadedReply && !request.promptIds.includes(replyTargetId)) {
      await message.reply("Reply directly to the pending Codex prompt before it expires.");
      await this.#recordAccepted(message.id, contentType);
      return;
    }
    if (!text) {
      await message.reply("Please answer the pending Codex prompt with text.");
      await this.#recordAccepted(message.id, contentType);
      return;
    }
    let result;
    try {
      result = resolveServerRequest(request, text);
    } catch (error) {
      await message.reply(error.message);
      await this.#recordAccepted(message.id, contentType);
      return;
    }
    this.codex.respond(request.id, result);
    this.#removePendingRequest(0, true);
    await message.react("✅").catch(() => {});
    await this.#recordAccepted(message.id, "codex-interaction");
    await this.#sendPendingRequest();
  }

  async handleCodexNotification(method, params) {
    if (method === "item/started" && params.item?.type === "fileChange") {
      this.fileChanges.set(params.item.id, params.item.changes || []);
      return;
    }
    if (method === "item/fileChange/patchUpdated") {
      this.fileChanges.set(params.itemId, params.changes || []);
      return;
    }
    if (method === "serverRequest/resolved") {
      const index = this.pendingRequests.findIndex((request) => request.id === params.requestId);
      if (index !== -1) {
        const wasCurrent = index === 0;
        this.#removePendingRequest(index, true);
        if (wasCurrent) await this.#sendPendingRequest();
      }
      return;
    }
    if (method === "turn/started") {
      this.activeTurnId = params.turn?.id || this.activeTurnId;
      return;
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const message = params.item.text?.trim() || "";
      const outbound = parseOutboundResponse(stripInternal(message));
      if (params.item.phase !== "final_answer" && outbound.reaction) {
        const target = this.targetByTurn.get(params.turnId);
        if (target) await this.#attemptReaction(params.turnId, target, outbound.reaction, "commentary");
      }
      if (outbound.reactionError) {
        await this.logger("warn", "reaction_directive_invalid", { phase: params.item.phase || "unknown" }, this.env);
      }
      if (params.item.phase === "final_answer" || !this.finalByTurn.has(params.turnId)) {
        this.finalByTurn.set(params.turnId, message);
      }
      return;
    }
    if (method === "item/completed" && params.item?.id) this.fileChanges.delete(params.item.id);
    if (method !== "turn/completed") return;
    const turnId = params.turn?.id || this.activeTurnId;
    const target = this.targetByTurn.get(turnId);
    const final = this.finalByTurn.get(turnId) || finalFromTurn(params.turn);
    let reactionState = this.reactionByTurn.get(turnId);
    this.activeTurnId = null;
    this.targetByTurn.delete(turnId);
    this.finalByTurn.delete(turnId);
    await this.space?.stopTyping().catch(() => {});
    if (!target) {
      this.reactionByTurn.delete(turnId);
      await this.#startQueuedTurn();
      return;
    }
    if (params.turn?.status === "completed" && (final || reactionState)) {
      const outbound = parseOutboundResponse(stripInternal(final));
      if (outbound.reactionError) {
        await this.logger("warn", "reaction_directive_invalid", { phase: "final_answer" }, this.env);
      }
      if (outbound.reaction && !reactionState) {
        reactionState = await this.#attemptReaction(turnId, target, outbound.reaction, "final_answer");
      }
      const chunks = splitMessage(outbound.text);
      if (chunks.length) await target.reply(markdown(chunks[0]));
      for (const chunk of chunks.slice(1)) await target.space.send(markdown(chunk));
      if (!chunks.length && reactionState && !reactionState.sent) {
        await target.reply(text(reactionState.emoji));
      } else if (!chunks.length && outbound.reactionError) {
        await target.reply(text("I could not send that reaction."));
      }
      this.reactionByTurn.delete(turnId);
      await this.#recordReply(target.id);
      await this.#startQueuedTurn();
      return;
    }
    this.reactionByTurn.delete(turnId);
    await target.reply("I could not finish that Codex turn. Please try again.");
    await this.#recordReply(target.id);
    await this.#startQueuedTurn();
  }

  async #attemptReaction(turnId, target, emoji, phase) {
    const existing = this.reactionByTurn.get(turnId);
    if (existing) return existing;
    const state = { emoji, sent: false };
    this.reactionByTurn.set(turnId, state);
    try {
      const sent = requireProviderReceipt(await target.react(emoji), "reaction");
      state.sent = true;
      state.messageId = sent.id;
      await this.logger("info", "reaction_sent", { phase }, this.env);
    } catch (error) {
      await this.logger("warn", "reaction_failed", { phase, error: cleanError(error) }, this.env);
    }
    return state;
  }

  async #startControlServer() {
    const token = randomBytes(24).toString("base64url");
    this.controlServer = net.createServer((socket) => {
      let buffer = "";
      let receivedBytes = 0;
      let settled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (settled) return;
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > controlRequestLimit(this.config.maxAttachmentBytes)) {
          settled = true;
          socket.end(`${JSON.stringify({ ok: false, error: "control request exceeds the configured attachment limit" })}\n`);
          return;
        }
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        settled = true;
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
    if (request.command === "send-file") {
      return this.sendFile(request);
    }
    if (request.command === "react") return this.reactToMessage(request);
    const message = await space.getMessage(requiredText(request.messageId));
    if (!message) throw new Error("message not found");
    if (request.command === "reply") {
      const sent = await message.reply(markdown(requiredText(request.text)));
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
    const parity = this.codex?.parityReport();
    return {
      running: true,
      pid: process.pid,
      threadId: this.codex?.threadId || this.state.threadId,
      configParity: parity,
      account: this.codex?.account || null,
      pendingCodexRequests: this.pendingRequests.length,
      queuedMessages: this.messageQueue.length,
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

  async #recordAccepted(messageId, contentType) {
    await this.#updateState((state) => {
      state.acceptedMessageIds.push(messageId);
      state.runtime.acceptedMessages += 1;
      state.runtime.lastEventAt = new Date().toISOString();
    });
    await this.logger("info", "message_accepted", { contentType }, this.env);
  }

  async #enqueueMessage(input, message, contentType) {
    const entry = { messageId: message.id, input };
    await this.#updateState((state) => {
      state.messageQueue.push(entry);
      state.acceptedMessageIds.push(message.id);
      state.runtime.acceptedMessages += 1;
      state.runtime.lastEventAt = new Date().toISOString();
    });
    this.messageQueue.push({ ...entry, message });
    await this.logger("info", "message_queued", { contentType }, this.env);
  }

  #removePendingRequest(index, expired = false) {
    const [request] = this.pendingRequests.splice(index, 1);
    if (!request) return;
    clearTimeout(request.timer);
    if (expired) {
      const expiresAt = Date.now() + 10 * 60 * 1000;
      for (const promptId of request.promptIds) this.expiredPromptIds.set(promptId, expiresAt);
    }
  }

  async #expireRequest(id) {
    const index = this.pendingRequests.findIndex((request) => request.id === id);
    if (index === -1) return;
    const wasCurrent = index === 0;
    this.#removePendingRequest(index, true);
    if (wasCurrent) await this.#sendPendingRequest();
    const now = Date.now();
    for (const [promptId, expiresAt] of this.expiredPromptIds) {
      if (expiresAt <= now) this.expiredPromptIds.delete(promptId);
    }
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
  const base = String(value || "file").normalize("NFC").split(/[\\/]/).pop();
  const clean = base.replace(/[\u0000-\u001F\u007F:]+/g, "_").replace(/\p{Bidi_Control}/gu, "_").replace(/^\.+/, "").trim() || "file";
  if (Buffer.byteLength(clean) <= 240) return clean;
  const extension = path.extname(clean);
  const safeExtension = Buffer.byteLength(extension) <= 32 ? extension : "";
  return `${truncateUtf8(clean.slice(0, clean.length - safeExtension.length), 240 - Buffer.byteLength(safeExtension))}${safeExtension}`;
}

const REACTION_ALIASES = new Map([
  ["love", "❤️"],
  ["heart", "❤️"],
  ["like", "👍"],
  ["thumbsup", "👍"],
  ["+1", "👍"],
  ["dislike", "👎"],
  ["thumbsdown", "👎"],
  ["-1", "👎"],
  ["laugh", "😂"],
  ["emphasize", "‼️"],
  ["question", "❓"],
]);
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

export function normalizeReaction(value) {
  const raw = requiredText(value).normalize("NFC");
  const reaction = REACTION_ALIASES.get(raw.toLowerCase()) || raw;
  const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(reaction), ({ segment }) => segment);
  if (graphemes.length !== 1 || !EMOJI_PATTERN.test(reaction)) {
    throw new Error("reaction must be exactly one emoji");
  }
  return reaction;
}

export function normalizeMimeType(value) {
  const mimeType = requiredText(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) {
    throw new Error("attachment MIME type must be a valid MIME type (type/subtype)");
  }
  return mimeType;
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

export function splitApprovalPrompt(text, limit = 3500) {
  const source = String(text || "");
  if (source.length <= limit) return source ? [source] : [];
  if (limit < 32) throw new Error("approval message limit is too small");
  let total = Math.ceil(source.length / (limit - 32));
  while (true) {
    const payloads = approvalPayloads(source, limit, total);
    if (payloads.length === total) {
      const width = String(total).length;
      return payloads.map((payload, index) =>
        `Approval ${String(index + 1).padStart(width, "0")}/${total}\n${payload}`,
      );
    }
    total = payloads.length;
  }
}

function approvalPayloads(source, limit, total) {
  const payloads = [];
  const width = String(total).length;
  for (let offset = 0, part = 1; offset < source.length; part += 1) {
    const headerLength = `Approval ${String(part).padStart(width, "0")}/${total}\n`.length;
    let end = Math.min(source.length, offset + limit - headerLength);
    if (end < source.length && isHighSurrogate(source.charCodeAt(end - 1)) && isLowSurrogate(source.charCodeAt(end))) end -= 1;
    payloads.push(source.slice(offset, end));
    offset = end;
  }
  return payloads;
}

function isHighSurrogate(code) {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code) {
  return code >= 0xDC00 && code <= 0xDFFF;
}

export function parseOutboundResponse(text) {
  const source = String(text || "").trim();
  const prefix = "[[photon_reaction:";
  if (!source.startsWith(prefix)) return { reaction: null, text: source };
  const close = source.indexOf("]]", prefix.length);
  const lineBreak = source.search(/[\r\n]/);
  if (close === -1 || (lineBreak !== -1 && close > lineBreak)) {
    const remainder = lineBreak === -1 ? "" : source.slice(lineBreak + 1).trim();
    return { reaction: null, text: remainder, reactionError: "reaction directive is incomplete" };
  }
  const remainder = source.slice(close + 2).replace(/^[ \t]*(?:\r?\n)?/, "").trim();
  try {
    return { reaction: normalizeReaction(source.slice(prefix.length, close)), text: remainder };
  } catch (error) {
    return { reaction: null, text: remainder, reactionError: cleanError(error) };
  }
}

export async function snapshotFile(file, maxBytes) {
  const resolvedFile = path.resolve(requiredText(file));
  let handle;
  try {
    handle = await open(resolvedFile, "r");
  } catch {
    throw new Error("attachment file could not be opened");
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("attachment path is not a regular file");
    if (fileStat.size > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
    const chunks = [];
    let size = 0;
    let position = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const bytes = Buffer.concat(chunks, size);
    return {
      bytes,
      file: resolvedFile,
      name: path.basename(resolvedFile),
      size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function decodeAttachmentData(data, claimedSize, claimedSha256, maxBytes) {
  if (typeof data !== "string") throw new Error("encoded attachment data is required");
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw new Error(`attachment exceeds ${maxBytes} bytes`);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error("attachment data must be canonical base64");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > maxBytes) throw new Error(`attachment exceeds ${maxBytes} bytes`);
  if (!Number.isSafeInteger(claimedSize) || claimedSize < 0 || claimedSize !== bytes.byteLength) {
    throw new Error("attachment size does not match the caller snapshot");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(claimedSha256) || claimedSha256 !== sha256) {
    throw new Error("attachment SHA-256 does not match the caller snapshot");
  }
  return { bytes, sha256 };
}

export function controlRequestLimit(maxAttachmentBytes) {
  return Math.ceil(maxAttachmentBytes / 3) * 4 + 16 * 1024;
}

function requireProviderReceipt(message, kind) {
  if (!message?.id) throw new Error(`Photon did not return a ${kind} message receipt`);
  // iMessage reaction writes return target-message delivery flags, not reaction
  // delivery flags; the non-throwing write plus returned ID is the receipt.
  if (kind !== "reaction" && message.isSent === false) {
    throw new Error(`Photon reported that the ${kind} was not sent`);
  }
  if (typeof message.sendErrorCode === "number" && message.sendErrorCode !== 0) {
    throw new Error(`Photon reported that the ${kind} was not sent`);
  }
  if (message.attachmentMetadata?.some(({ transferState }) => transferState === "failed")) {
    throw new Error("Photon reported that the attachment transfer failed");
  }
  return message;
}

function truncateUtf8(value, maxBytes) {
  let output = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    if (Buffer.byteLength(output) + Buffer.byteLength(segment) > maxBytes) break;
    output += segment;
  }
  return output;
}

function textInput(text) {
  return { type: "text", text, text_elements: [] };
}

function messageText(message) {
  const content = unwrapReply(message.content);
  if (content?.type === "text") return content.text;
  if (content?.type === "markdown") return content.markdown;
  return "";
}

function unwrapReply(content) {
  return content?.type === "reply" ? content.content : content;
}

function fallbackTarget(messageId, space) {
  return {
    id: messageId,
    space,
    react: async () => undefined,
    reply: (content) => space.send(content),
  };
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

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 500);
}
