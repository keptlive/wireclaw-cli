/**
 * Claude Code CLI framework adapter.
 * Spawns `claude -p` with MCP config, session resume, and tool allowlisting.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { FrameworkAdapter, QueryOptions, QueryResult } from './types.js';

// Shared utilities from the parent module (injected at construction)
let log: (msg: string) => void;
let writeOutput: (output: any) => void;
let shouldClose: () => boolean;

const IPC_POLL_MS = 500;

export class ClaudeCodeAdapter implements FrameworkAdapter {
  readonly name = 'claude-code';

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
    const { prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt } = opts;
    let closedDuringQuery = false;

    // Write MCP config for the CLI
    this.writeMcpConfig(mcpServerPath, containerInput, sdkEnv);

    // Build global CLAUDE.md as append system prompt
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let appendPrompt = '';
    if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      appendPrompt = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    appendPrompt += `\n\n## Vault — Secure Secret Storage
When you receive a credential (API key, token, password), immediately store it with vault. Never write raw credentials to files or expose them in output.
- \`vault store NAME VALUE --url URL --auth bearer\` — encrypt and scrub raw value from workspace files
- \`vault request NAME METHOD /path\` — make authenticated API call (vault injects the credential)
- \`vault list\` — show stored secret names (never values)
- \`vault delete NAME\` — remove a secret
Auth types: bearer (default), basic, header:X-API-Key, query:api_key
Use vault request for all authenticated API calls — never retrieve raw credentials.\n`;

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
      '-p',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];

    if (sdkEnv.CLAUDE_MODEL) {
      args.push('--model', sdkEnv.CLAUDE_MODEL);
    }

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    args.push('--allowed-tools', ...allowedTools);

    for (const dir of extraDirs) {
      args.push('--add-dir', dir);
    }

    if (appendPrompt) {
      args.push('--append-system-prompt', appendPrompt);
    }

    const mcpPath = path.join(process.env.HOME || '/home/node', '.mcp.json');
    args.push('--mcp-config', mcpPath);

    log(`Spawning: claude ${args.slice(0, 6).join(' ')} ... (${args.length} args total)`);

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(containerInput.secrets || {})) {
      if (v) childEnv[k] = v;
    }
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

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('[') && trimmed.length > 3) {
            log(`[claude stderr] ${trimmed.slice(0, 200)}`);
          }
        }
      });

      child.stdin.write(prompt);
      child.stdin.end();

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
        setTimeout(pollIpc, IPC_POLL_MS);
      };
      setTimeout(pollIpc, IPC_POLL_MS);

      child.on('close', (code) => {
        ipcPolling = false;
        log(`Claude CLI exited with code ${code}`);

        if (stderr.includes('Failed to authenticate') || stderr.includes('401')) {
          log(`AUTH ERROR: ${stderr.slice(0, 300)}`);
        }

        let result: string | null = null;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.result) {
            result = parsed.result;
          } else if (parsed.content) {
            result = typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
          } else if (typeof parsed === 'string') {
            result = parsed;
          }
          if (parsed.session_id) {
            newSessionId = parsed.session_id;
          }
        } catch {
          result = stdout.trim() || null;
        }

        if (code !== 0 && !closedDuringQuery) {
          const errorText = stderr.trim() || result || `CLI exited with code ${code}`;
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
        writeOutput({ status: 'error', result: null, error: `Failed to spawn claude: ${err.message}` });
        reject(err);
      });
    });
  }

  private writeMcpConfig(
    mcpServerPath: string,
    containerInput: QueryOptions['containerInput'],
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

    if (sdkEnv.AGENTWIRE_API_KEY && sdkEnv.AGENTWIRE_AGENT_ID) {
      mcpConfig.mcpServers.agentwire = {
        type: 'http',
        url: `${sdkEnv.AGENTWIRE_URL || 'https://agentwire.run'}/api/mcp?agentId=${sdkEnv.AGENTWIRE_AGENT_ID}`,
        headers: { Authorization: `Bearer ${sdkEnv.AGENTWIRE_API_KEY}` },
      };
    }

    for (const [name, spec] of Object.entries(containerInput.mcpServers || {})) {
      if (name === 'wireclaw' || name === 'agentwire') continue;
      if ((spec.type === 'sse' || spec.type === 'http' || spec.type === 'streamable-http') && spec.url) {
        mcpConfig.mcpServers[name] = { type: spec.type === 'streamable-http' ? 'http' : spec.type, url: spec.url, headers: spec.headers };
      } else if (spec.command) {
        const resolvedEnv: Record<string, string> = {};
        for (const [k, rawV] of Object.entries(spec.env || {})) {
          const v = String(rawV);
          resolvedEnv[k] = v.startsWith('$') ? (sdkEnv[v.slice(1)] || '') : v;
        }
        mcpConfig.mcpServers[name] = { command: spec.command, args: spec.args || [], env: resolvedEnv };
      }
    }

    const mcpPath = path.join(process.env.HOME || '/home/node', '.mcp.json');
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
    log(`Wrote MCP config to ${mcpPath} (${Object.keys(mcpConfig.mcpServers).length} servers)`);
  }
}
