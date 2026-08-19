import { timingSafeEqual } from "node:crypto";
import net from "node:net";

export const CONTROL_PREFACE_LIMIT = 512;
export const CONTROL_BODY_LIMIT = 64 * 1024;
export const CONTROL_IDLE_TIMEOUT_MS = 10_000;
export const CONTROL_MAX_CONNECTIONS = 16;
const CONTROL_RESPONSE_LIMIT = 1024 * 1024;
const CONTROL_COMMANDS = new Set(["status", "stop", "send", "send-file", "reply", "react", "thread-new"]);

export function controlRequestLimit(maxAttachmentBytes) {
  return Math.ceil(maxAttachmentBytes / 3) * 4 + 16 * 1024;
}

export async function startControlServer({
  token,
  maxAttachmentBytes,
  handle,
  idleTimeoutMs = CONTROL_IDLE_TIMEOUT_MS,
  maxConnections = CONTROL_MAX_CONNECTIONS,
}) {
  let activeConnections = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    if (activeConnections >= maxConnections) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.end(response({ ok: false, error: "control connection limit reached" }));
      return;
    }
    activeConnections += 1;
    sockets.add(socket);
    socket.once("close", () => {
      activeConnections -= 1;
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.setTimeout(idleTimeoutMs, () => fail(socket, "control connection timed out"));

    let phase = "preface";
    let preface = Buffer.alloc(0);
    let body;
    let receivedBodyBytes = 0;
    let command;
    let bodyBytes;
    let settled = false;

    socket.on("data", (chunk) => {
      if (settled) return;
      if (phase === "preface") {
        const newline = chunk.indexOf(0x0A);
        if (newline === -1) {
          if (preface.byteLength + chunk.byteLength > CONTROL_PREFACE_LIMIT) {
            settled = true;
            fail(socket, "control preface is too large");
            return;
          }
          preface = Buffer.concat([preface, chunk]);
          return;
        }
        if (preface.byteLength + newline > CONTROL_PREFACE_LIMIT) {
          settled = true;
          fail(socket, "control preface is too large");
          return;
        }
        if (newline + 1 !== chunk.byteLength) {
          settled = true;
          fail(socket, "control body arrived before authentication");
          return;
        }
        preface = Buffer.concat([preface, chunk.subarray(0, newline)]);
        let parsed;
        try {
          parsed = JSON.parse(preface.toString("utf8"));
          validatePreface(parsed, token, maxAttachmentBytes);
        } catch (error) {
          settled = true;
          fail(socket, protocolError(error));
          return;
        }
        command = parsed.command;
        bodyBytes = parsed.bodyBytes;
        body = Buffer.allocUnsafe(bodyBytes);
        phase = "body";
        socket.write(response({ ok: true, ready: true }));
        return;
      }

      if (receivedBodyBytes + chunk.byteLength > bodyBytes) {
        settled = true;
        fail(socket, "control body exceeds declared length");
        return;
      }
      chunk.copy(body, receivedBodyBytes);
      receivedBodyBytes += chunk.byteLength;
      if (receivedBodyBytes !== bodyBytes) return;
      settled = true;
      socket.setTimeout(0);
      let fields;
      try {
        fields = JSON.parse(body.toString("utf8"));
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("invalid body");
      } catch {
        fail(socket, "control body is malformed");
        return;
      }
      void Promise.resolve(handle({ command, ...fields })).then(
        (result) => socket.end(response({ ok: true, result })),
        (error) => socket.end(response({ ok: false, error: String(error?.message || "control command failed") })),
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.destroyControlConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return server;
}

export function controlRequest({ port, token, command, body = {} }) {
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  validateCommand(command, bodyBuffer.byteLength, Number.MAX_SAFE_INTEGER);
  const preface = Buffer.from(`${JSON.stringify({ token, command, bodyBytes: bodyBuffer.byteLength })}\n`);
  if (preface.byteLength > CONTROL_PREFACE_LIMIT + 1) throw new Error("control preface is too large");

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let phase = "ready";
    let responseBuffer = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.end();
      callback(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_IDLE_TIMEOUT_MS, () => socket.destroy(new Error("control request timed out")));
    socket.on("connect", () => socket.write(preface));
    socket.on("data", (chunk) => {
      responseBuffer += chunk;
      if (Buffer.byteLength(responseBuffer) > CONTROL_RESPONSE_LIMIT) {
        socket.destroy(new Error("control response is too large"));
        return;
      }
      while (!settled) {
        const newline = responseBuffer.indexOf("\n");
        if (newline === -1) return;
        let parsed;
        try {
          parsed = JSON.parse(responseBuffer.slice(0, newline));
        } catch {
          socket.destroy(new Error("control response is malformed"));
          return;
        }
        responseBuffer = responseBuffer.slice(newline + 1);
        if (phase === "ready") {
          if (!parsed.ok || parsed.ready !== true) {
            finish(reject, new Error(parsed.error || "control authentication failed"));
            return;
          }
          phase = "result";
          if (command === "send-file") socket.setTimeout(0);
          else socket.setTimeout(30_000, () => socket.destroy(new Error("control request timed out")));
          socket.write(bodyBuffer);
          continue;
        }
        if (responseBuffer) {
          socket.destroy(new Error("control response has invalid framing"));
          return;
        }
        if (parsed.ok) finish(resolve, parsed.result);
        else finish(reject, new Error(parsed.error || "control command failed"));
      }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("end", () => {
      if (!settled) finish(reject, new Error("control connection closed without a complete response"));
    });
  });
}

function validatePreface(preface, token, maxAttachmentBytes) {
  if (!preface || typeof preface !== "object" || Array.isArray(preface)) throw new Error("malformed");
  if (Object.keys(preface).sort().join(",") !== "bodyBytes,command,token") throw new Error("malformed");
  if (!sameToken(preface.token, token)) throw new Error("unauthorized");
  validateCommand(preface.command, preface.bodyBytes, maxAttachmentBytes);
}

function validateCommand(command, bodyBytes, maxAttachmentBytes) {
  if (!CONTROL_COMMANDS.has(command)) throw new Error("unknown command");
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 2) throw new Error("invalid body length");
  const limit = command === "send-file" ? controlRequestLimit(maxAttachmentBytes) : CONTROL_BODY_LIMIT;
  if (bodyBytes > limit) throw new Error("body limit");
}

function sameToken(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function protocolError(error) {
  const message = String(error?.message || "");
  if (message === "unauthorized") return "unauthorized";
  if (message === "unknown command") return "unknown control command";
  if (message === "body limit") return "control body exceeds the command limit";
  if (message === "invalid body length") return "control body length is invalid";
  return "control preface is malformed";
}

function fail(socket, error) {
  socket.end(response({ ok: false, error }));
}

function response(value) {
  return `${JSON.stringify(value)}\n`;
}
