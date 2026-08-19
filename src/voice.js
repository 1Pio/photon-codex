import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { credentialFreeEnvironment, readElevenLabsApiKey } from "./config.js";

const execFileAsync = promisify(execFile);
const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
const REQUEST_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
const VOICE_TEXT_LIMIT = 5_000;
const INSTRUCT_LIMIT = 500;
const M4A_MIME_TYPES = new Set(["audio/mp4", "audio/mp4a-latm", "audio/x-m4a", "audio/aac", "audio/aacp"]);
const ELEVENLABS_INPUT_MIME_TYPES = new Set([
  "audio/aac", "audio/aiff", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus",
  "audio/wav", "audio/webm", "audio/x-aiff", "audio/x-m4a", "audio/x-wav",
]);

export class VoiceService {
  constructor({
    config,
    env = process.env,
    fetchImpl = globalThis.fetch,
    execFileImpl = execFileAsync,
    platform = process.platform,
    streamIdleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
    streamOverallTimeoutMs = REQUEST_TIMEOUT_MS,
  } = {}) {
    this.config = config;
    this.env = env;
    this.fetch = fetchImpl;
    this.execFile = execFileImpl;
    this.platform = platform;
    this.streamIdleTimeoutMs = streamIdleTimeoutMs;
    this.streamOverallTimeoutMs = streamOverallTimeoutMs;
  }

  async transcribe(content, maxBytes) {
    const apiKey = readElevenLabsApiKey(this.env);
    const bytes = await readVoiceContent(
      content,
      maxBytes,
      this.streamIdleTimeoutMs,
      this.streamOverallTimeoutMs,
    );
    const normalized = await normalizeTranscriptionAudio(
      bytes,
      content.mimeType,
      this.execFile,
      maxBytes,
      this.platform,
      credentialFreeEnvironment(this.env),
    );
    const transcript = await elevenLabsTranscribe({
      apiKey,
      bytes: normalized.bytes,
      mimeType: normalized.mimeType,
      name: normalized.name,
      model: this.config.elevenlabs.sttModel,
      fetchImpl: this.fetch,
    });
    return transcript;
  }

  async synthesize(value, instructValue) {
    const text = voiceText(value);
    const instruct = optionalInstruct(instructValue);
    if (this.config.ttsEngine === "elevenlabs") {
      if (instruct) throw new Error("--instruct is available with the msd speech engine; use [audio tags] with ElevenLabs");
      const source = await elevenLabsSpeech({
        apiKey: readElevenLabsApiKey(this.env),
        text,
        model: this.config.elevenlabs.ttsModel,
        voiceId: this.config.elevenlabs.voiceId,
        voiceSettings: elevenLabsVoiceSettings(this.config.elevenlabs),
        fetchImpl: this.fetch,
        maxBytes: this.config.maxAttachmentBytes,
      });
      const normalized = await normalizeM4a(
        source.bytes,
        source.mimeType,
        this.execFile,
        this.config.maxAttachmentBytes,
        this.platform,
        credentialFreeEnvironment(this.env),
      );
      return { ...normalized, engine: "elevenlabs", model: this.config.elevenlabs.ttsModel };
    }
    if (this.config.ttsEngine === "msd") {
      const source = await msdSpeech({
        text,
        instruct,
        voice: this.config.msd.voice,
        execFileImpl: this.execFile,
        maxBytes: this.config.maxAttachmentBytes,
        childEnv: credentialFreeEnvironment(this.env),
      });
      const normalized = await normalizeM4a(
        source.bytes,
        source.mimeType,
        this.execFile,
        this.config.maxAttachmentBytes,
        this.platform,
        credentialFreeEnvironment(this.env),
      );
      return { ...normalized, engine: "msd", model: null };
    }
    throw new Error("voice speech engine is not available");
  }
}

function elevenLabsVoiceSettings(config) {
  if (config.ttsModel === "eleven_v3") return { stability: config.stability };
  return {
    stability: config.stability,
    similarity_boost: config.similarityBoost,
    speed: config.speed,
  };
}

export async function elevenLabsTranscribe({ apiKey, bytes, mimeType, name, model = "scribe_v2", fetchImpl = globalThis.fetch }) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), name);
  form.append("model_id", model);
  form.append("timestamps_granularity", "none");
  form.append("tag_audio_events", "true");
  form.append("diarize", "false");
  form.append("no_verbatim", "false");
  form.append("use_multi_channel", "false");
  form.append("webhook", "false");
  const response = await providerFetch(fetchImpl, `${ELEVENLABS_API}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": requiredApiKey(apiKey) },
    body: form,
  }, "transcription");
  requireContentType(response, "application/json", "transcription");
  const responseBytes = await readResponse(response, 1024 * 1024);
  let result;
  try {
    result = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    throw new Error("ElevenLabs transcription returned an invalid response");
  }
  const text = String(result?.text || "").trim();
  if (!text) throw new Error("ElevenLabs transcription returned no text");
  return text;
}

export async function elevenLabsSpeech({
  apiKey,
  text,
  model,
  voiceId,
  voiceSettings,
  fetchImpl = globalThis.fetch,
  maxBytes,
}) {
  const response = await providerFetch(
    fetchImpl,
    `${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": requiredApiKey(apiKey) },
      body: JSON.stringify({ text: voiceText(text), model_id: model, ...(voiceSettings ? { voice_settings: voiceSettings } : {}) }),
    },
    "speech synthesis",
  );
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() || "";
  if (!mimeType.startsWith("audio/")) throw new Error("ElevenLabs speech synthesis returned invalid audio");
  return { bytes: await readResponse(response, maxBytes), mimeType };
}

async function msdSpeech({ text, instruct, voice, execFileImpl, maxBytes, childEnv }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "photon-codex-msd-"));
  const input = path.join(dir, "input.txt");
  const output = path.join(dir, "output.wav");
  try {
    await writeFile(input, text, { mode: 0o600 });
    const args = ["hermes", "--input", input, "--output", output, "--format", "wav", "--json"];
    if (voice) args.push("--voice", voice);
    if (instruct) args.push("--instruct", instruct);
    try {
      await execFileImpl("msd", args, {
        env: childEnv,
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("msd is not installed on PATH");
      if (error?.killed || error?.signal) throw new Error("msd speech synthesis timed out");
      throw new Error("msd speech synthesis failed");
    }
    try {
      return { bytes: await readBoundedFile(output, maxBytes), mimeType: "audio/wav" };
    } catch (error) {
      if (/exceeds \d+ bytes/.test(error?.message || "")) throw error;
      throw new Error("msd speech synthesis did not produce usable audio");
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function normalizeTranscriptionAudio(bytes, mimeType, execFileImpl, maxBytes, platform, childEnv) {
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  if (ELEVENLABS_INPUT_MIME_TYPES.has(normalizedMimeType)) {
    return { bytes, mimeType: normalizedMimeType, name: inputName(normalizedMimeType) };
  }
  const converted = await normalizeM4a(bytes, normalizedMimeType, execFileImpl, maxBytes, platform, childEnv);
  return { ...converted, name: "voice.m4a" };
}

async function normalizeM4a(bytes, mimeType, execFileImpl, maxBytes, platform, childEnv) {
  if (M4A_MIME_TYPES.has(String(mimeType || "").toLowerCase()) && isM4a(bytes)) {
    return { bytes, mimeType: "audio/mp4", name: "voice.m4a" };
  }
  if (platform === "darwin") {
    const converted = await convertAudio(bytes, execFileImpl, maxBytes, childEnv, {
      command: "/usr/bin/afconvert",
      args: (input, output) => ["-f", "m4af", "-d", "aac", input, output],
      unavailable: "voice audio conversion failed",
    });
    return { bytes: converted, mimeType: "audio/mp4", name: "voice.m4a" };
  }
  const converted = await convertAudio(bytes, execFileImpl, maxBytes, childEnv, {
    command: "ffmpeg",
    args: (input, output) => ["-nostdin", "-y", "-i", input, "-f", "ipod", "-c:a", "aac", output],
    unavailable: "voice audio conversion failed; install ffmpeg on PATH",
  });
  return { bytes: converted, mimeType: "audio/mp4", name: "voice.m4a" };
}

async function convertAudio(bytes, execFileImpl, maxBytes, childEnv, converter) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "photon-codex-audio-"));
  const input = path.join(dir, "input-audio");
  const output = path.join(dir, "voice.m4a");
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    try {
      await execFileImpl(converter.command, converter.args(input, output), {
        env: childEnv,
        timeout: REQUEST_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(converter.unavailable);
      throw new Error("voice audio conversion failed");
    }
    try {
      const converted = await readBoundedFile(output, maxBytes);
      if (!isM4a(converted)) throw new Error("voice audio conversion failed");
      return converted;
    } catch (error) {
      if (/exceeds \d+ bytes/.test(error?.message || "")) throw error;
      throw new Error("voice audio conversion failed");
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readVoiceContent(content, maxBytes, idleTimeoutMs, overallTimeoutMs) {
  if (Number.isFinite(content.size) && content.size > maxBytes) throw new Error(`voice message exceeds ${maxBytes} bytes`);
  if (typeof content.stream === "function") {
    const stream = await withTimeout(Promise.resolve().then(() => content.stream()), overallTimeoutMs);
    const iterator = stream?.[Symbol.asyncIterator]?.();
    if (!iterator) throw new Error("voice message stream is invalid");
    const chunks = [];
    let size = 0;
    const deadline = Date.now() + overallTimeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("voice message read timed out");
        const next = await withTimeout(iterator.next(), Math.min(idleTimeoutMs, remaining));
        if (next.done) break;
        const bytes = Buffer.from(next.value);
        size += bytes.byteLength;
        if (size > maxBytes) throw new Error(`voice message exceeds ${maxBytes} bytes`);
        chunks.push(bytes);
      }
    } finally {
      try {
        const returned = iterator.return?.();
        if (returned?.catch) void returned.catch(() => {});
      } catch {}
    }
    return Buffer.concat(chunks, size);
  }
  const bytes = await withTimeout(content.read(), overallTimeoutMs);
  if (bytes.byteLength > maxBytes) throw new Error(`voice message exceeds ${maxBytes} bytes`);
  return bytes;
}

async function withTimeout(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("voice message read timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedFile(file, maxBytes) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("voice synthesis did not produce a regular file");
    if (stat.size === 0) throw new Error("voice synthesis produced no audio");
    if (stat.size > maxBytes) throw new Error(`voice audio exceeds ${maxBytes} bytes`);
    return await readFile(handle);
  } finally {
    await handle.close();
  }
}

async function providerFetch(fetchImpl, url, options, operation) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error(`ElevenLabs ${operation} timed out`);
    throw new Error(`ElevenLabs ${operation} is unavailable`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("ElevenLabs authentication failed");
    if (response.status === 429) throw new Error(`ElevenLabs ${operation} rate limit reached`);
    if (response.status >= 500) throw new Error(`ElevenLabs ${operation} is unavailable`);
    throw new Error(`ElevenLabs ${operation} was rejected`);
  }
  return response;
}

async function readResponse(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(`voice audio exceeds ${maxBytes} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error(`voice audio exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function requireContentType(response, expected, operation) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  if (contentType !== expected) throw new Error(`ElevenLabs ${operation} returned an invalid response`);
}

function requiredApiKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("ElevenLabs API key is missing");
  return key;
}

function voiceText(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("voice text is required");
  const text = value.trim();
  if (text.length > VOICE_TEXT_LIMIT) throw new Error(`voice text exceeds ${VOICE_TEXT_LIMIT} characters`);
  return text;
}

function optionalInstruct(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error("--instruct must contain text");
  const instruct = value.trim();
  if (instruct.length > INSTRUCT_LIMIT) throw new Error(`--instruct exceeds ${INSTRUCT_LIMIT} characters`);
  return instruct;
}

function inputName(mimeType) {
  const extension = new Map([
    ["audio/aac", "aac"], ["audio/aiff", "aiff"], ["audio/flac", "flac"], ["audio/mp4", "m4a"],
    ["audio/mpeg", "mp3"], ["audio/ogg", "ogg"], ["audio/opus", "opus"], ["audio/wav", "wav"],
    ["audio/webm", "webm"], ["audio/x-aiff", "aiff"], ["audio/x-m4a", "m4a"], ["audio/x-wav", "wav"],
  ]).get(mimeType) || "audio";
  return `voice.${extension}`;
}

function isM4a(bytes) {
  if (bytes.byteLength < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;
  return new Set(["M4A ", "M4B ", "M4P ", "mp42", "mp41", "isom", "iso2"]).has(bytes.toString("ascii", 8, 12));
}
