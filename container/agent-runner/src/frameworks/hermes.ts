/**
 * Hermes Agent framework adapter (NousResearch).
 * Spawns the `hermes` CLI — a self-improving AI agent that supports
 * any LLM provider (OpenRouter, Nous Portal, z.ai, etc.).
 *
 * Key differences from Claude Code:
 * - Binary: `hermes` (installed via NousResearch install script)
 * - Config: Uses `hermes model` for provider settings, env vars for API keys
 * - Supports session resume via conversation IDs
 * - Has its own tool/skill system
 * - Non-interactive mode: `hermes run <message>` (similar to opencode run)
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { FrameworkAdapter, QueryOptions, QueryResult } from './types.js';

let log: (msg: string) => void;
let writeOutput: (output: any) => void;
let shouldClose: () => boolean;

const IPC_POLL_MS = 500;

export class HermesAdapter implements FrameworkAdapter {
  readonly name = 'hermes';

  constructor(deps: {
    log: (msg: string) => void;
    writeOutput: (output: any) => void;
    shouldClose: () => boolean;
  }) {
    log = deps.log;
    writeOutput = deps.writeOutput;
    shouldClose = deps.shouldClose;
  }

  async runQuery(opts: QueryOptions): Promise<QueryResult> {
    const { prompt, containerInput, sdkEnv } = opts;
    let closedDuringQuery = false;

    // Build env for the child process
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(containerInput.secrets || {})) {
      if (v) childEnv[k] = v;
    }
    childEnv.HOME = process.env.HOME || '/home/node';

    // Set WireClaw IPC context env vars so wireclaw-ipc CLI works inside Hermes
    childEnv.WIRECLAW_CHAT_JID = containerInput.chatJid;
    childEnv.WIRECLAW_GROUP_FOLDER = containerInput.groupFolder;
    childEnv.WIRECLAW_IS_MAIN = containerInput.isMain ? '1' : '0';
    childEnv.WIRECLAW_REPLY_TYPE = containerInput.replyContext?.type || '';
    childEnv.WIRECLAW_REPLY_FROM = containerInput.replyContext?.from || '';
    childEnv.WIRECLAW_REPLY_SUBJECT = containerInput.replyContext?.subject || '';

    // Hermes uses provider env vars
    if (sdkEnv.ANTHROPIC_BASE_URL) childEnv.ANTHROPIC_BASE_URL = sdkEnv.ANTHROPIC_BASE_URL;
    if (sdkEnv.ANTHROPIC_API_KEY) childEnv.ANTHROPIC_API_KEY = sdkEnv.ANTHROPIC_API_KEY;
    // Hermes reads API keys from environment — ensure they're in childEnv
    // These come from group .env (loaded into process.env) or sdkEnv (global secrets)
    for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'NOUS_API_KEY', 'ZAI_API_KEY', 'KIMI_API_KEY', 'MINIMAX_API_KEY']) {
      if (sdkEnv[key]) childEnv[key] = sdkEnv[key] as string;
      else if (process.env[key]) childEnv[key] = process.env[key] as string;
    }

    // Prepend IPC tool docs so Hermes knows how to communicate via WireClaw
    const ipcDocs = `## WireClaw IPC Tools
You have access to these commands via your terminal tool to communicate with the outside world:

- \`wireclaw-ipc send_message "your message"\` — Send a message to the user/talk page
- \`echo '{"command":"reply_email","body":"response text","subject":"Re: Subject"}' | wireclaw-ipc\` — Reply to the inbound email
- \`echo '{"command":"send_email","to":"user@email.com","subject":"Hi","body":"Hello"}' | wireclaw-ipc\` — Send a new email
- \`echo '{"command":"schedule_task","prompt":"do X","schedule_type":"cron","schedule_value":"0 9 * * *"}' | wireclaw-ipc\` — Schedule a recurring task
- \`wireclaw-ipc system_health\` — Run a VPS health check (main agent only)
- \`wireclaw-ipc list_commands\` — List all available commands

IMPORTANT: To respond to the user, you MUST use your terminal tool to run wireclaw-ipc commands. Your stdout is NOT sent to the user. Only wireclaw-ipc routes messages to the user.

Example — to reply to an email, use your terminal tool to run:
echo '{"command":"reply_email","body":"Hello! I received your message.","subject":"Re: Hello"}' | wireclaw-ipc

Example — to send a talk page message, use your terminal tool to run:
wireclaw-ipc send_message "Hello from Hermes!"

Always use the terminal tool for these commands. Do not try to use send_email or post_message functions directly — they don't exist. Use wireclaw-ipc via terminal instead.

`;
    const augmentedPrompt = ipcDocs + prompt;

    const args: string[] = [
      'chat',
      '-q', augmentedPrompt,
      '--quiet',           // Machine-readable output (no TUI)
      '--yolo',            // Skip dangerous command prompts
      '--source', 'tool',  // Mark as programmatic (not user CLI session)
      '--verbose',         // Log tool calls and reasoning to stderr for observability
    ];

    // Provider detection from model string (e.g. "openrouter/model" → --provider openrouter)
    const rawModel = sdkEnv.CLAUDE_MODEL || '';
    const providerMatch = rawModel.match(/^(openrouter|nous|anthropic|zai|kimi-coding|minimax)\//);
    const provider = providerMatch ? providerMatch[1] : 'openrouter';
    const modelName = providerMatch ? rawModel.slice(providerMatch[0].length) : rawModel;

    if (modelName) {
      args.push('--model', modelName);
    }
    if (providerMatch) {
      args.push('--provider', provider);
    }

    if (opts.sessionId) {
      args.push('--resume', opts.sessionId);
    }

    // Write Hermes config.yaml before spawning — Hermes reads provider/model from its config file
    const hermesConfigDir = path.join(childEnv.HOME || '/home/node', '.hermes');
    const hermesConfigPath = path.join(hermesConfigDir, 'config.yaml');
    fs.mkdirSync(hermesConfigDir, { recursive: true });

    const configLines = [
      `model:`,
      `  provider: ${provider}`,
      `  default: "${modelName}"`,
    ];
    // Pass API key via config if available
    if (sdkEnv.OPENROUTER_API_KEY || childEnv.OPENROUTER_API_KEY) {
      configLines.push(`  api_key: "${sdkEnv.OPENROUTER_API_KEY || childEnv.OPENROUTER_API_KEY}"`);
    }
    fs.writeFileSync(hermesConfigPath, configLines.join('\n') + '\n');
    log(`Wrote Hermes config: provider=${provider}, model=${modelName}`);

    // Hermes binary is at /home/node/.local/bin/hermes
    const hermesBin = '/home/node/.local/bin/hermes';
    childEnv.PATH = `/home/node/.local/bin:${childEnv.PATH || '/usr/local/bin:/usr/bin:/bin'}`;

    // Register API key with Hermes auth system (required — env vars alone don't work)
    // Match provider to the correct API key env var
    const providerKeyMap: Record<string, string> = {
      openrouter: 'OPENROUTER_API_KEY',
      nous: 'NOUS_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      zai: 'ZAI_API_KEY',
      'kimi-coding': 'KIMI_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      'openai-codex': 'OPENAI_API_KEY',
    };
    const keyName = providerKeyMap[provider] || '';
    const apiKey = (keyName && childEnv[keyName]) || childEnv.OPENROUTER_API_KEY || childEnv.OPENAI_API_KEY || '';
    if (apiKey && provider) {
      try {
        const { execFileSync } = await import('child_process');
        execFileSync(hermesBin, ['auth', 'add', provider, '--type', 'api-key', '--api-key', apiKey, '--label', 'wireclaw'], {
          cwd: '/workspace/group',
          env: childEnv,
          stdio: 'pipe',
          timeout: 10000,
        });
        log(`Registered API key with Hermes for provider: ${provider}`);
      } catch (err: any) {
        log(`Hermes auth add warning: ${err.message?.slice(0, 100) || err}`);
      }
    }

    log(`Spawning: hermes ${args.slice(0, 6).join(' ')} ... (${args.length} args total)`);

    return new Promise((resolve, reject) => {
      const child = spawn(hermesBin, args, {
        cwd: '/workspace/group',
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && trimmed.length > 3) {
            log(`[hermes stderr] ${trimmed.slice(0, 200)}`);
          }
        }
      });

      child.stdin.end();

      let ipcPolling = true;
      const pollIpc = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          log('Close sentinel detected, killing hermes process');
          closedDuringQuery = true;
          child.kill('SIGTERM');
          ipcPolling = false;
          return;
        }
        setTimeout(pollIpc, IPC_POLL_MS);
      };
      setTimeout(pollIpc, IPC_POLL_MS);

      child.on('close', (code) => {
        ipcPolling = false;
        log(`Hermes exited with code ${code}`);

        // Parse Hermes output. In --quiet mode it outputs the response with
        // some TUI formatting (box chars, tool output, session_id line).
        // Strip ANSI codes, box drawing, tool output lines, and extract session ID.
        let result: string | null = null;
        let newSessionId: string | undefined;
        const raw = stdout
          // Strip ANSI escape codes
          .replace(/\x1b\[[0-9;]*m/g, '')
          // Strip carriage returns
          .replace(/\r/g, '');

        const lines = raw.trim().split('\n');
        const textLines: string[] = [];
        for (const line of lines) {
          // Extract session_id from output (format: "session_id: 20260331_xxx")
          const sessionMatch = line.match(/session_id:\s*(\S+)/i);
          if (sessionMatch) {
            newSessionId = sessionMatch[1];
            continue;
          }
          // Skip TUI box chars, tool status lines, init lines, empty decorative lines
          const stripped = line.replace(/[┊╭╰╮╯│─]/g, '').trim();
          if (!stripped) continue;
          // Skip emoji-prefixed status lines (init, tool prep, warnings)
          if (stripped.match(/^[⚡🤖🔗🔑✅⚠️📊🛠️📝📋💡💀❌🔌🌐⏱️⚕🔊]/)) continue;
          if (stripped.startsWith('preparing ')) continue;
          if (stripped.match(/^Enabled toolset/)) continue;
          if (stripped.match(/^(Final tool|Loaded \d+ tools|Context limit|Some tools)/)) continue;
          // Skip tool call JSON blocks
          if (stripped.startsWith('{') && stripped.includes('"name"')) continue;
          // Skip "Since neither..." meta-reasoning about tool availability
          if (stripped.match(/^Since neither|^However,|^the best alternative/i)) continue;
          textLines.push(stripped);
        }
        result = textLines.join('\n').trim() || null;
        if (result) log(`Result: ${result.slice(0, 200)}`);

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
        log(`Failed to spawn hermes: ${err.message}`);
        writeOutput({ status: 'error', result: null, error: `Failed to spawn hermes: ${err.message}` });
        reject(err);
      });
    });
  }
}
