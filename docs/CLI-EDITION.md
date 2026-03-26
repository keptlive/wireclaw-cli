# WireClaw CLI Edition

## Overview

WireClaw CLI Edition is a fork of [WireClaw](https://github.com/keptlive/wireclaw) that replaces the Agent SDK with the Claude Code CLI for container execution. This enables **Claude Max subscription** usage from servers without needing Console API keys with prepaid credits.

### Why CLI Edition?

The Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`) requires `ANTHROPIC_API_KEY` from the Claude Console with prepaid credits. OAuth tokens from `claude login` are not supported by the SDK — it returns "OAuth token has expired" even with valid tokens.

The Claude Code CLI (`claude -p`) handles OAuth token exchange internally and fully supports Max subscription authentication. By spawning `claude -p` as a child process inside containers instead of calling the SDK's `query()` function, we get the same capabilities with Max subscription billing.

## Architecture

### Before (Agent SDK)
```
Message → Host Process → Container → agent-runner → query({ prompt, options }) → API
                                                         ↑
                                                    Agent SDK handles auth
                                                    via ANTHROPIC_API_KEY
```

### After (CLI Edition)
```
Message → Host Process → Container → agent-runner → spawn('claude', ['-p', ...]) → API
                                                         ↑
                                                    Claude CLI handles auth
                                                    via ~/.claude/.credentials.json
                                                    (from 'claude login')
```

### Key Changes

| Component | Agent SDK Version | CLI Edition |
|-----------|------------------|-------------|
| **Auth** | `ANTHROPIC_API_KEY` env var | `claude login` OAuth token in `.credentials.json` |
| **Execution** | `query()` from `@anthropic-ai/claude-agent-sdk` | `spawn('claude', ['-p', '--dangerously-skip-permissions', ...])` |
| **MCP Servers** | Passed as SDK options object | Written to `.mcp.json`, loaded via `--mcp-config` flag |
| **Model Selection** | `model` option in SDK | `--model` CLI flag |
| **Session Resume** | `resume` option in SDK | `--resume` CLI flag |
| **Tool Permissions** | `permissionMode` SDK option | `--dangerously-skip-permissions` CLI flag |
| **System Prompt** | `systemPrompt` SDK option | `--append-system-prompt` CLI flag |
| **Output** | Async iterator of message objects | JSON output via `--output-format json` |
| **Hooks** | SDK `PreToolUse`/`PreCompact` callbacks | CLI's built-in hook system via `.claude/settings.json` |
| **Dependencies** | `@anthropic-ai/claude-agent-sdk` npm package | `@anthropic-ai/claude-code` global install |
| **Billing** | Console API credits (prepaid) | Max subscription (included) |

## Setup

### Prerequisites

- Linux server (tested on Ubuntu)
- Node.js 20+
- Docker
- Claude Max subscription

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/keptlive/wireclaw-cli.git
cd wireclaw-cli

# 2. Install host dependencies
npm install

# 3. Build host TypeScript
npm run build

# 4. Install Claude Code CLI globally
npm install -g @anthropic-ai/claude-code

# 5. Login to Claude (opens browser auth flow)
claude login

# 6. Build the Docker container
cd container && bash build.sh && cd ..

# 7. Copy credentials to the agent's session directory
# (replace 'andy' with your agent's group folder name)
mkdir -p data/sessions/andy/.claude
cp ~/.claude/.credentials.json data/sessions/andy/.claude/.credentials.json
cp ~/.claude/.claude.json data/sessions/andy/.claude/.claude.json 2>/dev/null || echo '{}' > data/sessions/andy/.claude/.claude.json
chown -R 1000:1000 data/sessions/andy/.claude/

# 8. Start the service
# (set up systemd service first — see Service Setup below)
systemctl start wireclaw
```

### Service Setup

Create `/etc/systemd/system/wireclaw.service`:

```ini
[Unit]
Description=WireClaw Agent Manager
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=/root/wireclaw-cli
ExecStart=/usr/bin/node /root/wireclaw-cli/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=AUTO_APPLY_MANIFESTS=true

[Install]
WantedBy=multi-user.target
```

Then:
```bash
systemctl daemon-reload
systemctl enable wireclaw
systemctl start wireclaw
```

## Token Management

### How Tokens Work

1. `claude login` on the server creates an OAuth token at `~/.claude/.credentials.json`
2. The token is copied to `data/sessions/{agent}/.claude/.credentials.json`
3. This directory is mounted into the container at `/home/node/.claude/`
4. The entrypoint symlinks `.claude.json` from inside `.claude/` to `/home/node/.claude.json`
5. The Claude CLI inside the container reads the token and handles OAuth exchange

### Token Refresh

OAuth tokens expire every ~12 hours. When Andy stops responding with auth errors:

```bash
# 1. Re-login on the server
claude login

# 2. Copy fresh token to the agent's session directory
cp ~/.claude/.credentials.json data/sessions/andy/.claude/.credentials.json
chown 1000:1000 data/sessions/andy/.claude/.credentials.json

# 3. Restart the service
systemctl restart wireclaw
```

### Important: data/ vs store/

WireClaw has TWO session directories:
- `data/sessions/{agent}/.claude/` — **bind-mounted into containers** (this is what the CLI reads)
- `store/sessions/{agent}/.claude/` — used by the host process for session metadata

**Always copy credentials to `data/sessions/`**, not `store/sessions/`. The container only sees the `data/` mount.

### File Permissions

The container runs as `node` (uid 1000). All files in `data/sessions/{agent}/.claude/` must be owned by uid 1000:

```bash
chown -R 1000:1000 data/sessions/andy/.claude/
```

## Container Details

### What's Inside

The container (`wireclaw-agent:latest`) includes:
- Node.js 22
- Claude Code CLI (`@anthropic-ai/claude-code`)
- Chromium (for browser automation via `agent-browser`)
- Python 3 with research libraries (requests, arxiv, beautifulsoup4, etc.)
- File processing tools (pdftotext, pandoc, imagemagick, ffmpeg, tesseract, jq)
- Git and curl

### Mount Points

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `groups/{agent}/` | `/workspace/group` | Agent's working directory, CLAUDE.md, .env |
| `data/sessions/{agent}/.claude/` | `/home/node/.claude` | OAuth credentials, CLI config, sessions |
| `data/sessions/{agent}/agent-runner-src/` | `/app/src` | Agent runner source (bind-mount override) |
| `data/ipc/{agent}/` | `/workspace/ipc` | IPC messages and close sentinel |
| `groups/global/` | `/workspace/global` | Shared CLAUDE.md (read-only for non-main) |
| Project root | `/workspace/project` | Read-only access to WireClaw source |

### Entrypoint Flow

1. Symlinks `.claude.json` from `.claude/` to home directory
2. Compiles TypeScript agent-runner from `/app/src/` to `/tmp/dist/`
3. Links `node_modules`
4. Reads container input JSON from stdin
5. Runs the agent-runner

### Agent Runner Flow

1. Reads `ContainerInput` JSON from stdin (prompt, secrets, MCP config, etc.)
2. Writes MCP server config to `~/.mcp.json`
3. Builds CLI argument list:
   - `-p` (pipe mode)
   - `--dangerously-skip-permissions`
   - `--output-format json`
   - `--model {model}`
   - `--resume {sessionId}` (if resuming)
   - `--allowed-tools {tools}`
   - `--mcp-config ~/.mcp.json`
   - `--append-system-prompt {globalClaudeMd}`
   - `--add-dir {extraDirs}`
4. Spawns `claude` with the prompt piped to stdin
5. Captures JSON output (`.result`, `.session_id`)
6. Emits result via `WIRECLAW_OUTPUT_START/END` markers
7. Waits for next IPC message or close sentinel
8. On new message: runs another `claude -p --resume {sessionId}` call

### Multi-Turn Conversations

The CLI pipe mode (`-p`) is one-shot: it reads stdin, processes, and exits. Multi-turn conversations work via the session resume loop:

```
Message 1 → claude -p "prompt" → response + session_id
                                      ↓
Message 2 → claude -p --resume session_id "prompt" → response
                                      ↓
Message 3 → claude -p --resume session_id "prompt" → response
```

IPC follow-up messages that arrive during an active CLI process are queued and sent in the next `--resume` call.

## MCP Server Configuration

The agent-runner generates `.mcp.json` before each CLI invocation. It includes:

### Built-in MCP Servers

- **wireclaw** — IPC-based MCP server for sending messages, managing tasks
- **agentwire** — AgentWire platform tools (email, SMS, memory) via Streamable HTTP

### Custom MCP Servers

Defined in `groups/{agent}/wireclaw.yaml` manifest:

```yaml
dependencies:
  mcp_servers:
    memory:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-memory"]
    custom-api:
      type: "http"
      url: "https://api.example.com/mcp"
      headers:
        Authorization: "Bearer $MY_API_KEY"
```

Environment variable references (`$VAR_NAME`) in MCP server env/headers are resolved from the agent's secrets at runtime.

## Differences from Upstream

### Removed
- `@anthropic-ai/claude-agent-sdk` npm dependency
- SDK `query()` function call
- `MessageStream` async iterator class
- `HookCallback`, `PreCompactHookInput`, `PreToolUseHookInput` types
- `createSanitizeBashHook()` — CLI manages its own subprocess env
- `createPreCompactHook()` — replaced with `archiveTranscript()` standalone function
- `CLAUDE_CODE_OAUTH_TOKEN` from required env vars
- `ANTHROPIC_AUTH_TOKEN` from required env vars

### Added
- `writeMcpConfig()` — generates `.mcp.json` from container input
- `spawn('claude', [...])` — CLI child process management
- JSON output parsing (`.result`, `.session_id`)
- Entrypoint `.claude.json` symlink
- `archiveTranscript()` — standalone conversation archival

### Modified
- `container/agent-runner/src/index.ts` — core rewrite
- `container/agent-runner/package.json` — removed agent-sdk dependency
- `container/Dockerfile` — updated entrypoint, comments
- `src/container-runner.ts` — removed OAuth env vars from required list, added `.claude.json` provisioning

## Troubleshooting

### "OAuth token has expired"

The OAuth token needs refreshing. See [Token Refresh](#token-refresh).

### "Claude configuration file not found at: /home/node/.claude.json"

The entrypoint symlink isn't working. Check that `.claude.json` exists inside `data/sessions/{agent}/.claude/`:

```bash
ls -la data/sessions/andy/.claude/.claude.json
# If missing, create it:
echo '{}' > data/sessions/andy/.claude/.claude.json
chown 1000:1000 data/sessions/andy/.claude/.claude.json
```

### "No conversation found with session ID"

The agent is trying to resume a session from the Agent SDK era. Clear the session:

```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='andy';"
systemctl restart wireclaw
```

### Container exits immediately

Check container logs:
```bash
CID=$(docker ps -a --filter name=andy --format '{{.ID}}' | head -1)
docker logs $CID 2>&1
```

### Permissions errors

Ensure `data/sessions/{agent}/.claude/` is owned by uid 1000:
```bash
chown -R 1000:1000 data/sessions/andy/.claude/
```

## Rollback

If something goes wrong, restore from backup:

```bash
# Stop the CLI edition
systemctl stop wireclaw

# Point service back to original
sed -i 's|WorkingDirectory=/root/wireclaw-cli|WorkingDirectory=/root/wireclaw|' /etc/systemd/system/wireclaw.service
sed -i 's|/root/wireclaw-cli/dist|/root/wireclaw/dist|' /etc/systemd/system/wireclaw.service
systemctl daemon-reload
systemctl start wireclaw
```

Or restore from backup:
```bash
# Backup was created at: /root/wireclaw-backup-YYYYMMDD-HHMM/
cp -r /root/wireclaw-backup-*/groups-andy/* /root/wireclaw/groups/andy/
cp /root/wireclaw-backup-*/messages.db /root/wireclaw/store/messages.db
```
