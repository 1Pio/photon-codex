# photon-codex

`photon-codex` is a small bridge between one Photon iMessage conversation and one persistent Codex thread.

It is deliberately one process and one runtime dependency surface. Photon streams messages directly into the process. Codex runs through the authenticated local `codex app-server`. Final Codex answers return as iMessage replies. There is no public webhook, model API key, database, framework, or separate queue service.

## What it handles

- Text, images, files, voice messages, and reactions inbound
- Images as native Codex `localImage` inputs
- Other attachments as private local files that Codex can inspect
- Persistent Codex thread resumption
- Native Codex config inheritance, with optional reasoning-effort and fast-mode overrides only
- iMessage handling for Codex approvals, permission requests, user questions, and app forms
- Crash-safe FIFO follow-up queuing or active-turn steering, matching Codex's configured queue mode
- Direct-message and exact-sender isolation
- Provider receipt/status events ignored before Codex starts
- Separate accepted-message and successful-reply state
- Message-ID deduplication across restarts
- Text and exact-byte file sends, threaded replies, and native or custom emoji reactions through one CLI
- A small, restart-on-failure macOS service
- Bounded, content-free operational logging
- Photon telemetry disabled by default

Photon still processes the iMessage content. A Free or Pro Photon project uses a shared line. This tool does not change those provider properties.

## Requirements

- Node.js 20 or newer
- An authenticated local `codex` CLI
- A Photon Spectrum project with iMessage connected
- One Photon user number in E.164 format

## Setup

```sh
npm install
npm link
photon-codex init
photon-codex auth set   # macOS Keychain; secret is not written to config
photon-codex doctor
photon-codex service install
```

`service install` is the recommended macOS runtime. It installs one per-user LaunchAgent that starts at login and restarts only after failure. Use `photon-codex run` for foreground development. On Linux or Windows, set `PHOTON_PROJECT_SECRET` instead of using `auth set` and use your normal process supervisor.

Configuration, private attachments, a bounded operational log, and small runtime state live under `~/.config/photon-codex/` by default. Set `PHOTON_CODEX_HOME` to change that location. New installations use `~/.config/photon-codex/workspace` as a neutral private Codex workspace, so unrelated tasks cannot dirty the bridge source repository. Choose another workspace during `init` or later with `photon-codex workspace set PATH`.

`config.json` contains Photon transport settings and may contain one narrow Codex performance overlay:

```json
{
  "projectId": "your-photon-project-id",
  "allowedSender": "+15551234567",
  "cwd": "/path/to/your/workspace",
  "maxAttachmentBytes": 52428800,
  "codexOverrides": {
    "reasoningEffort": "extra high",
    "fastMode": true
  }
}
```

`codexOverrides` is optional, and either field may be omitted independently. Omitted fields inherit the effective native Codex configuration. `reasoningEffort` accepts only `light`, `medium`, `high`, `extra high`, or `max`; these map to Codex's native `low`, `medium`, `high`, `xhigh`, and `max` values. `fastMode: true` selects Codex's `fast` service tier, which the provider reports as `priority`. `fastMode: false` explicitly selects the default non-priority tier.

No other Codex setting can be overridden here. App-server still resolves the normal Codex layers from `$CODEX_HOME/config.toml` and trusted project `.codex/config.toml` files for `cwd`, exactly as Codex does in its other local clients. photon-codex passes the two validated values through app-server's supported process-level `--config` mechanism, then supplies those same app-server-resolved values when starting or resuming a thread so stale rollout metadata cannot win. The same effective values therefore apply to new threads, resumed threads, restarts, and every later turn. The running process never reloads this file mid-turn, and `turn/steer` carries no settings, so an active steered turn is not mutated. Restart the service after changing the overlay. On macOS, photon-codex prefers the Codex executable bundled with the installed ChatGPT desktop app so its protocol and feature version match the app; set `PHOTON_CODEX_BIN` only when you deliberately want another executable.

Photon credentials and project identifiers are removed from the Codex child environment. The only Photon-specific value retained is the non-secret `PHOTON_CODEX_HOME` locator when configured, so an agent's `photon-codex send-file` and reaction commands reach the same local bridge.

Run `photon-codex doctor` after changing native Codex configuration or `codexOverrides`, then `photon-codex service restart`. Doctor launches an ephemeral app-server thread, reads the resolved effective config through the native `config/read` API, and compares every corresponding field reported by the thread, including model, reasoning effort, service tier, approval policy, reviewer, sandbox network policy, and workspace. Its `performance` report marks each setting as `native` or `override`, shows the configured and effective values, and verifies them against the thread. `photon-codex status` exposes the same report for the live persistent thread. Legacy top-level `reasoningEffort` and `fastMode` fields remain ignored; only the nested two-field object is recognized.

`state.json` contains the persistent Codex thread, bound conversation, bounded accepted/replied/ignored event IDs, truthful counters, and the current loopback control endpoint. The Photon secret is not stored in either file or in the service definition.

The first accepted direct message from the configured sender binds the bridge to that exact Photon conversation. This inbound-first handshake is required by Photon's shared iMessage line before agent-initiated sends. Later messages from groups, other senders, or another conversation are ignored before Codex starts.

## Agent-friendly control

```sh
photon-codex status
photon-codex logs 50
photon-codex send "Hello"
photon-codex send-file "/path/to/document.pdf" application/pdf
photon-codex reply MESSAGE_ID "Got it"
photon-codex react MESSAGE_ID 👍
photon-codex thread new
photon-codex stop
photon-codex workspace set /path/to/workspace
photon-codex service restart
```

All control commands print structured JSON. They talk only to the locally running bridge over a token-authenticated loopback connection. `status` reports process and service health, the native Codex config parity result, authenticated account type, pending Codex prompts, queued messages, delivery counters, and the last safe operational error. It does not treat ingestion as proof of delivery.

`send-file` opens the file once in the calling CLI process, enforces the configured limit while reading, and sends an authenticated size-and-hash-checked byte envelope to the service. Photon receives that in-memory snapshot, never a mutable path. This keeps file access subject to the caller's normal Codex sandbox instead of turning the unsandboxed service into a way around it. The receipt includes the Photon message ID, byte count, SHA-256, requested MIME type, and the provider-reported MIME type when available. Spectrum's iMessage transport derives the actual provider type from the preserved filename rather than forwarding the requested MIME field. `providerAccepted: true` means Photon's write completed; only delivery metadata or observation in Messages establishes recipient delivery.

Reactions accept one emoji grapheme. The classic Tapbacks `❤️`, `👍`, `👎`, `😂`, `‼️`, and `❓` use their native iMessage forms; other emoji use iMessage custom reactions. The CLI also accepts the aliases `love`, `like`, `dislike`, `laugh`, `emphasize`, and `question`. Codex can place a private reaction directive in commentary for an immediate acknowledgement or at the start of its final answer. The directive is always removed, including when malformed. A failed reaction never blocks answer text, and a failed reaction-only response falls back to the emoji as ordinary text.

The operational log is `~/.config/photon-codex/runtime.log`. It records event types and health outcomes, never message bodies, phone numbers, conversation IDs, credentials, or attachment contents. It rotates at 512 KiB and retains one previous file.

macOS service control is deliberately small:

```sh
photon-codex service status
photon-codex service start
photon-codex service stop
photon-codex service restart
photon-codex service uninstall
```

## Permissions and client boundary

The bridge does not choose a safety mode. Codex inherits `approval_policy`, `approvals_reviewer`, `sandbox_mode`, permission profiles, network policy, rules, and tool configuration from native Codex config. If Codex asks the client for approval or input, photon-codex sends the full exact scope over as many iMessages as needed. Reply `allow`, `always`, `deny`, or `cancel`; ordinary questions accept a direct answer, and supported app forms accept `key=value` lines. Secret-input requests, approval requests whose exact scope is unavailable, and app form schemas the lean client cannot fully validate are rejected safely instead of being weakened. Auto-resolving prompts require a threaded iMessage reply so a late answer cannot become an unrelated Codex request.

This provides Codex core-config parity, not a claim that iMessage becomes the desktop UI. Desktop-only widgets, screen context, macOS TCC grants owned by the desktop process, and other host-injected UI capabilities cannot be reproduced by config inheritance. photon-codex does not advertise unsupported host capabilities and fails them explicitly instead of silently widening permissions.

Inbound attachments are stored with private permissions, sanitized names, and a 50 MB default limit. Override the limit with `PHOTON_CODEX_MAX_ATTACHMENT_BYTES`.

## Development

```sh
npm test
npm run test:live
npm run doctor
```

`npm run test:live` uses the installed, authenticated Codex app-server. It checks native inheritance, each partial overlay, the combined overlay, explicit fast-mode disable, effective-value reporting, restart/resume of the same persisted thread, and a subsequent live turn. Its temporary persistent thread is archived when the test finishes.

Codex app-server is the official open-source embedding interface used for threads, turns, approvals, history, and streamed agent events. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [openai/codex source](https://github.com/openai/codex/tree/main/codex-rs/app-server). The media implementation follows Photon's documented [Spectrum reactions and replies](https://photon.codes/docs/spectrum-ts/reactions-and-replies) and [Advanced iMessage attachment](https://github.com/photon-hq/advanced-imessage-ts#send-attachments) contracts.
