# photon-codex

`photon-codex` is a small bridge between one Photon iMessage conversation and one persistent Codex thread.

It is deliberately one process and one runtime dependency surface. Photon streams messages directly into the process. Codex runs through the authenticated local `codex app-server`. Final Codex answers return as iMessage replies. There is no public webhook, model API key, database, framework, or separate queue service.

## What it handles

- Text, images, files, voice messages, and reactions inbound
- Images as native Codex `localImage` inputs
- Other attachments as private local files that Codex can inspect
- Persistent Codex thread resumption
- Fast Codex service tier requested explicitly and reported by app-server as `priority`
- Active-turn steering when another iMessage arrives
- Direct-message and exact-sender isolation
- Message-ID deduplication across restarts
- Text sends, threaded replies, and reactions through one CLI
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
photon-codex run
```

On Linux or Windows, set `PHOTON_PROJECT_SECRET` instead of using `auth set`.

Configuration and small runtime state live under `~/.config/photon-codex/` by default. Set `PHOTON_CODEX_HOME` to change that location. `config.json` contains the public project ID, allowed sender, workspace path, and attachment limit. `state.json` contains the Codex thread ID, bound conversation ID, a bounded deduplication list, and the current local control endpoint. The Photon secret is not stored in either file.

The first accepted direct message from the configured sender binds the bridge to that exact Photon conversation. This inbound-first handshake is required by Photon's shared iMessage line before agent-initiated sends. Later messages from groups, other senders, or another conversation are ignored before Codex starts.

## Agent-friendly control

```sh
photon-codex status
photon-codex send "Hello"
photon-codex reply MESSAGE_ID "Got it"
photon-codex react MESSAGE_ID like
photon-codex thread new
photon-codex stop
```

All control commands print structured JSON. They talk only to the locally running bridge over a token-authenticated loopback connection.

## Safety model

The bridge starts Codex with `workspace-write` and approvals disabled. This makes unattended iMessage operation predictable: Codex can work inside the configured workspace, but it cannot pause on an approval prompt or silently escape the sandbox. When a task needs authority outside that boundary, the answer should explain the limitation and the user can continue in a normal Codex task.

Inbound attachments are stored with private permissions, sanitized names, and a 50 MB default limit. Override the limit with `PHOTON_CODEX_MAX_ATTACHMENT_BYTES`.

## Development

```sh
npm test
npm run doctor
```
