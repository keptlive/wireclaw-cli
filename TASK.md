# WireClaw CLI Rewrite — Replace Agent SDK with Claude Code CLI

## Goal
Replace `@anthropic-ai/claude-agent-sdk` `query()` with `claude -p --dangerously-skip-permissions` CLI calls inside containers. This enables OAuth authentication via `claude login` (Max subscription) instead of requiring Console API keys.

## Why
- Agent SDK doesn't support OAuth token exchange — returns "OAuth token has expired"
- Claude Code CLI handles OAuth internally and works with `claude login`
- The container already has `@anthropic-ai/claude-code` installed globally
- This is the only way to use Max subscription from servers

## Architecture Change

### Before (Agent SDK)
```
stdin JSON → agent-runner → query({ prompt, options: { mcpServers, env, model, ... } }) → stream messages
```

### After (CLI)
```
stdin JSON → agent-runner → spawn `claude -p` with:
  - prompt piped to stdin
  - MCP servers via .mcp.json file
  - env vars passed to child process
  - CLAUDE.md for system prompt
  - --model flag for model selection
  - --dangerously-skip-permissions for non-interactive
→ capture stdout as response
```

## Tasks

### Phase 1: Core CLI Integration [IN PROGRESS]
- [x] 1.1 Create `runClaude()` function that spawns `claude -p --dangerously-skip-permissions`
- [x] 1.2 Handle stdin/stdout — pipe prompt in, capture response out
- [x] 1.3 Pass environment variables to child process (secrets, model, etc.)
- [x] 1.4 Handle exit codes and errors
- [x] 1.5 Remove `@anthropic-ai/claude-agent-sdk` dependency

### Phase 2: MCP Server Support
- [x] 2.1 Generate `.mcp.json` file from `containerInput.mcpServers` config
- [x] 2.2 Write to container's home dir before spawning CLI
- [x] 2.3 Include WireClaw MCP server (IPC-based)
- [x] 2.4 Include AgentWire MCP server
- [x] 2.5 Include custom MCP servers from manifest

### Phase 3: System Prompt & Context
- [x] 3.1 Write system prompt to CLAUDE.md in working directory
- [ ] 3.2 Append global CLAUDE.md content
- [x] 3.3 Handle additional directories

### Phase 4: Session Management
- [x] 4.1 Pass `--resume` flag for session continuity
- [x] 4.2 Parse session ID from CLI output
- [x] 4.3 Handle session storage

### Phase 5: IPC Message Piping
- [ ] 5.1 Handle follow-up messages via IPC during active CLI session
- [x] 5.2 Detect _close sentinel to terminate CLI
- [x] 5.3 Support multi-turn conversations

### Phase 6: Output Parsing
- [x] 6.1 Parse CLI output to extract assistant text
- [x] 6.2 Emit output in WIRECLAW_OUTPUT_START/END markers
- [ ] 6.3 Handle tool calls and results in output

### Phase 7: Hooks & Security
- [ ] 7.1 Sanitize bash commands (unset secrets)
- [ ] 7.2 Pre-compact hook for assistant name
- [x] 7.3 Permission mode (--dangerously-skip-permissions)

### Phase 8: Testing & Deployment
- [ ] 8.1 Update Dockerfile (remove agent-sdk, keep claude-code)
- [x] 8.2 Update package.json dependencies
- [ ] 8.3 Test locally with docker build
- [ ] 8.4 Deploy to WireClaw server
- [ ] 8.5 Test with `claude login` OAuth token

## Key CLI Flags
```
claude -p                          # Non-interactive (pipe mode)
  --dangerously-skip-permissions   # Skip permission prompts
  --model claude-opus-4-6          # Model selection
  --resume SESSION_ID              # Resume session
  --output-format json             # JSON output for parsing
  --mcp-config .mcp.json           # MCP server config
  --append-system-prompt "..."     # Additional system prompt
```

## Files to Modify
- `container/agent-runner/src/index.ts` — Main rewrite (replace query() with spawn claude)
- `container/agent-runner/package.json` — Remove agent-sdk dependency
- `container/Dockerfile` — Update if needed
- `src/container-runner.ts` — May need changes for credential mounting

## Current Status
Phase 1-6 DONE. Phase 7-8 remaining.
