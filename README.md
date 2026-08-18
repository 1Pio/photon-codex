# photon-codex

`photon-codex` is a small bridge between one Photon iMessage conversation and one persistent Codex thread.

It is deliberately one process and one runtime dependency surface. Photon streams messages directly into the process. Codex runs through the authenticated local `codex app-server`. Final Codex answers return as iMessage replies. There is no public webhook, model API key, database, framework, or separate queue service.

## What it handles

- Text, images, files, voice messages, and reactions inbound
- Images as native Codex `localImage` inputs
- Other attachments as private local files that Codex can inspect
- Persistent Codex thread resumption
- Native Codex config inheritance for model, reasoning, fast tier, permissions, tools, apps, plugins, skills, and MCP servers
- iMessage handling for Codex approvals, permission requests, user questions, and app forms
- Crash-safe FIFO follow-up queuing or active-turn steering, matching Codex's configured queue mode
- Direct-message and exact-sender isolation
- Provider receipt/status events ignored before Codex starts
- Separate accepted-message and successful-reply state
- Message-ID deduplication across restarts
- Text and file sends, threaded replies, and reactions through one CLI
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

`config.json` contains only Photon transport settings:

```json
{
  "projectId": "your-photon-project-id",
  "allowedSender": "+15551234567",
  "cwd": "/path/to/your/workspace",
  "maxAttachmentBytes": 52428800
}
```

Codex settings do not belong in this file. The bridge starts Codex app-server without model, reasoning, service-tier, approval, sandbox, personality, summary, or generic config overrides. App-server resolves the normal Codex layers from `$CODEX_HOME/config.toml` and trusted project `.codex/config.toml` files for `cwd`, exactly as Codex does in its other local clients. On macOS, photon-codex prefers the Codex executable bundled with the installed ChatGPT desktop app so its protocol and feature version match the app; set `PHOTON_CODEX_BIN` only when you deliberately want another executable.

Run `photon-codex doctor` after changing Codex configuration, then `photon-codex service restart`. Doctor launches an ephemeral app-server thread, reads the effective config through the native `config/read` API, and compares every corresponding field reported by the thread, including model, reasoning effort, service tier, approval policy, reviewer, sandbox network policy, and workspace. `photon-codex status` exposes the same scoped inheritance report for the live persistent thread and distinguishes mismatches from fields an older resumed thread does not report. Legacy `reasoningEffort` and `fastMode` fields are ignored and removed the next time photon-codex writes `config.json`.

`state.json` contains the persistent Codex thread, bound conversation, bounded accepted/replied/ignored event IDs, truthful counters, and the current loopback control endpoint. The Photon secret is not stored in either file or in the service definition.

The first accepted direct message from the configured sender binds the bridge to that exact Photon conversation. This inbound-first handshake is required by Photon's shared iMessage line before agent-initiated sends. Later messages from groups, other senders, or another conversation are ignored before Codex starts.

## Agent-friendly control

```sh
photon-codex status
photon-codex logs 50
photon-codex send "Hello"
photon-codex send-file /path/to/document.pdf application/pdf
photon-codex reply MESSAGE_ID "Got it"
photon-codex react MESSAGE_ID like
photon-codex thread new
photon-codex stop
photon-codex workspace set /path/to/workspace
photon-codex service restart
```

All control commands print structured JSON. They talk only to the locally running bridge over a token-authenticated loopback connection. `status` reports process and service health, the native Codex config parity result, authenticated account type, pending Codex prompts, queued messages, delivery counters, and the last safe operational error. It does not treat ingestion as proof of delivery.

`send-file` delivers a local document or other file through the bound Photon conversation. Codex can also react to the current iMessage with a private response directive; the bridge sends the emoji reaction and removes the directive before delivering any remaining answer text.

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
npm run doctor
```

Codex app-server is the official open-source embedding interface used for threads, turns, approvals, history, and streamed agent events. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [openai/codex source](https://github.com/openai/codex/tree/main/codex-rs/app-server).
