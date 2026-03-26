/**
 * WireClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

interface McpServerConfig {
  command?: string;
  args?: string[];
  type?: 'sse' | 'http' | 'streamable-http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  mcpServers?: Record<string, McpServerConfig>;
  systemPackages?: string[];
  replyContext?: {
    type: string;
    from: string;
    subject?: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
// MessageStream removed — CLI uses stdin pipe instead of SDK async iterator

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---WIRECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---WIRECLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Note: Bash command sanitization (secret stripping) is now handled by
// the CLI's own permission system and the --dangerously-skip-permissions flag.
// Secrets are passed via env to the CLI child process but the CLI manages
// its own subprocess environments.

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 * Supports type: 'message' (user text) and type: 'reminder' (system guidance).
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        } else if (data.type === 'reminder' && data.text) {
          const category = data.category || 'general';
          log(`System reminder injected: category=${category}`);
          messages.push(`<system-reminder category="${category}">\n${data.text}\n</system-reminder>`);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Build MCP config JSON and write to ~/.mcp.json for the CLI to discover.
 */
function writeMcpConfig(
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
): void {
  const mcpConfig: Record<string, Record<string, unknown>> = {
    mcpServers: {
      wireclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          WIRECLAW_CHAT_JID: containerInput.chatJid,
          WIRECLAW_GROUP_FOLDER: containerInput.groupFolder,
          WIRECLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          WIRECLAW_REPLY_TYPE: containerInput.replyContext?.type || '',
          WIRECLAW_REPLY_FROM: containerInput.replyContext?.from || '',
          WIRECLAW_REPLY_SUBJECT: containerInput.replyContext?.subject || '',
        },
      },
    },
  };

  // AgentWire MCP
  if (sdkEnv.AGENTWIRE_API_KEY && sdkEnv.AGENTWIRE_AGENT_ID) {
    mcpConfig.mcpServers.agentwire = {
      type: 'http',
      url: `${sdkEnv.AGENTWIRE_URL || 'https://agentwire.run'}/api/mcp?agentId=${sdkEnv.AGENTWIRE_AGENT_ID}`,
      headers: {
        Authorization: `Bearer ${sdkEnv.AGENTWIRE_API_KEY}`,
      },
    };
  }

  // Custom MCP servers from manifest
  for (const [name, spec] of Object.entries(containerInput.mcpServers || {})) {
    if (name === 'wireclaw' || name === 'agentwire') continue;
    if ((spec.type === 'sse' || spec.type === 'http' || spec.type === 'streamable-http') && spec.url) {
      mcpConfig.mcpServers[name] = { type: spec.type === 'streamable-http' ? 'http' : spec.type, url: spec.url, headers: spec.headers };
    } else if (spec.command) {
      const resolvedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.env || {})) {
        resolvedEnv[k] = v.startsWith('$') ? (sdkEnv[v.slice(1)] || '') : v;
      }
      mcpConfig.mcpServers[name] = { command: spec.command, args: spec.args || [], env: resolvedEnv };
    }
  }

  const mcpPath = path.join(process.env.HOME || '/home/node', '.mcp.json');
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
  log(`Wrote MCP config to ${mcpPath} (${Object.keys(mcpConfig.mcpServers).length} servers)`);
}

/**
 * Run a single query by spawning `claude -p` CLI process.
 * Replaces the Agent SDK query() call with the Claude Code CLI,
 * which properly handles OAuth token exchange for Max subscription auth.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  let closedDuringQuery = false;

  // Write MCP config for the CLI
  writeMcpConfig(mcpServerPath, containerInput, sdkEnv);

  // Build global CLAUDE.md as append system prompt
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let appendPrompt = '';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    appendPrompt = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }

  // Build allowed tools list
  const customToolPatterns: string[] = [];
  for (const name of Object.keys(containerInput.mcpServers || {})) {
    if (name !== 'wireclaw' && name !== 'agentwire') {
      customToolPatterns.push(`mcp__${name}__*`);
    }
  }

  const allowedTools = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__wireclaw__*',
    'mcp__agentwire__*',
    ...customToolPatterns,
  ];

  // Build CLI arguments
  const args: string[] = [
    '-p',                                          // Non-interactive pipe mode
    '--dangerously-skip-permissions',              // Skip permission prompts
    '--output-format', 'json',                     // Structured JSON output
  ];

  // Model selection
  if (sdkEnv.CLAUDE_MODEL) {
    args.push('--model', sdkEnv.CLAUDE_MODEL);
  }

  // Session resume
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // Allowed tools
  args.push('--allowed-tools', ...allowedTools);

  // Additional directories
  for (const dir of extraDirs) {
    args.push('--add-dir', dir);
  }

  // System prompt append (global CLAUDE.md)
  if (appendPrompt) {
    args.push('--append-system-prompt', appendPrompt);
  }

  // MCP config
  const mcpPath = path.join(process.env.HOME || '/home/node', '.mcp.json');
  args.push('--mcp-config', mcpPath);

  log(`Spawning: claude ${args.slice(0, 6).join(' ')} ... (${args.length} args total)`);

  // Build env for the child process — merge secrets but DON'T expose them in process.env
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(containerInput.secrets || {})) {
    if (v) childEnv[k] = v;
  }
  // Ensure HOME is set for CLI to find .claude/ credentials
  childEnv.HOME = process.env.HOME || '/home/node';

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: '/workspace/group',
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let newSessionId: string | undefined;

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Log stderr lines that contain useful info
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('[') && trimmed.length > 3) {
          log(`[claude stderr] ${trimmed.slice(0, 200)}`);
        }
      }
    });

    // Pipe the prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // Poll IPC for _close sentinel during the query
    let ipcPolling = true;
    const pollIpc = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, killing CLI process');
        closedDuringQuery = true;
        child.kill('SIGTERM');
        ipcPolling = false;
        return;
      }
      // Note: follow-up IPC messages during an active CLI session are not supported
      // in pipe mode — they will be queued for the next runQuery() call
      setTimeout(pollIpc, IPC_POLL_MS);
    };
    setTimeout(pollIpc, IPC_POLL_MS);

    child.on('close', (code) => {
      ipcPolling = false;
      log(`Claude CLI exited with code ${code}`);

      if (stderr.includes('Failed to authenticate') || stderr.includes('401')) {
        log(`AUTH ERROR: ${stderr.slice(0, 300)}`);
      }

      // Parse JSON output
      let result: string | null = null;
      try {
        const parsed = JSON.parse(stdout);
        // JSON output format: { type: "result", subtype: "success", result: "...", session_id: "..." }
        if (parsed.result) {
          result = parsed.result;
        } else if (parsed.content) {
          // Alternative format
          result = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
        } else if (typeof parsed === 'string') {
          result = parsed;
        }
        if (parsed.session_id) {
          newSessionId = parsed.session_id;
        }
      } catch {
        // If not valid JSON, treat stdout as plain text result
        result = stdout.trim() || null;
      }

      // Handle errors
      if (code !== 0 && !closedDuringQuery) {
        const errorText = stderr.trim() || result || `CLI exited with code ${code}`;
        // Check if the error is an auth failure — include it as the result so the user sees it
        if (stderr.includes('authenticate') || stderr.includes('401') || stderr.includes('OAuth')) {
          result = errorText;
        }
        log(`CLI error (code ${code}): ${errorText.slice(0, 200)}`);
      }

      if (result) {
        log(`Result: ${result.slice(0, 200)}`);
      }

      writeOutput({
        status: code === 0 || closedDuringQuery ? 'success' : 'error',
        result,
        newSessionId,
        ...(code !== 0 && !closedDuringQuery ? { error: stderr.trim().slice(0, 500) } : {}),
      });

      resolve({ newSessionId, lastAssistantUuid: undefined, closedDuringQuery });
    });

    child.on('error', (err) => {
      ipcPolling = false;
      log(`Failed to spawn claude CLI: ${err.message}`);
      writeOutput({
        status: 'error',
        result: null,
        error: `Failed to spawn claude: ${err.message}`,
      });
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Load group-level .env file if it exists. These are agent-managed env vars
  // (e.g. API tokens the agent collected itself). They're set in process.env
  // so Bash commands and tools can access them.
  const groupEnvPath = '/workspace/group/.env';
  if (fs.existsSync(groupEnvPath)) {
    for (const line of fs.readFileSync(groupEnvPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
    log(`Loaded group .env (${groupEnvPath})`);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
