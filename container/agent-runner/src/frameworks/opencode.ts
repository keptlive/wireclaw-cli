/**
 * OpenCode framework adapter.
 * Spawns the `opencode` CLI — an open-source coding agent that supports
 * multiple LLM providers via OpenAI-compatible APIs.
 *
 * Key differences from Claude Code:
 * - Binary: `opencode` (must be installed in the container)
 * - Config: Uses ~/.config/opencode/config.json for provider/model settings
 * - No session resume (fresh context each query)
 * - Supports MCP servers natively
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { FrameworkAdapter, QueryOptions, QueryResult } from './types.js';

let log: (msg: string) => void;
let writeOutput: (output: any) => void;
let shouldClose: () => boolean;

const IPC_POLL_MS = 500;

export class OpenCodeAdapter implements FrameworkAdapter {
  readonly name = 'opencode';

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

    // Set WireClaw IPC context env vars so wireclaw-ipc CLI works inside OpenCode
    childEnv.WIRECLAW_CHAT_JID = opts.containerInput.chatJid;
    childEnv.WIRECLAW_GROUP_FOLDER = opts.containerInput.groupFolder;
    childEnv.WIRECLAW_IS_MAIN = opts.containerInput.isMain ? '1' : '0';
    childEnv.WIRECLAW_REPLY_TYPE = opts.containerInput.replyContext?.type || '';
    childEnv.WIRECLAW_REPLY_FROM = opts.containerInput.replyContext?.from || '';
    childEnv.WIRECLAW_REPLY_SUBJECT = opts.containerInput.replyContext?.subject || '';

    // Set model/provider via environment
    if (sdkEnv.ANTHROPIC_BASE_URL) childEnv.ANTHROPIC_BASE_URL = sdkEnv.ANTHROPIC_BASE_URL;
    if (sdkEnv.ANTHROPIC_API_KEY) childEnv.ANTHROPIC_API_KEY = sdkEnv.ANTHROPIC_API_KEY;

    const args: string[] = [
      'run',
      '--format', 'json',
    ];

    if (sdkEnv.CLAUDE_MODEL) {
      args.push('--model', sdkEnv.CLAUDE_MODEL);
    }

    // Session resume
    if (opts.sessionId) {
      args.push('--session', opts.sessionId);
    }

    // Prepend IPC tool docs so OpenCode knows how to communicate via WireClaw
    const ipcDocs = `[WireClaw IPC] You can send messages/emails via: wireclaw-ipc send_message "text" or echo '{"command":"reply_email","body":"..."}' | wireclaw-ipc. Run wireclaw-ipc list_commands for all options.\n\n`;
    args.push(ipcDocs + prompt);

    log(`Spawning: opencode ${args.slice(0, 4).join(' ')} ... (${args.length} args total)`);

    return new Promise((resolve, reject) => {
      const child = spawn('opencode', args, {
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
            log(`[opencode stderr] ${trimmed.slice(0, 200)}`);
          }
        }
      });

      child.stdin.end();

      let ipcPolling = true;
      const pollIpc = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          log('Close sentinel detected, killing opencode process');
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
        log(`OpenCode exited with code ${code}`);

        // Parse OpenCode JSON event stream.
        // Events are newline-delimited JSON objects:
        //   {"type":"step_start", "sessionID":"ses_...", "part":{...}}
        //   {"type":"text", "sessionID":"ses_...", "part":{"type":"text","text":"Hi!",...}}
        //   {"type":"tool_start/tool_finish", ...}
        //   {"type":"step_finish", "part":{"reason":"stop","tokens":{...}}}
        let result: string | null = null;
        let newSessionId: string | undefined;
        const textParts: string[] = [];
        try {
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              // Extract session ID from any event
              if (event.sessionID) {
                newSessionId = event.sessionID;
              }
              // Collect text content from text events
              if (event.type === 'text' && event.part?.text) {
                textParts.push(event.part.text);
              }
              // Also handle tool output (e.g. bash results)
              if (event.type === 'tool_finish' && event.part?.output) {
                textParts.push(event.part.output);
              }
            } catch { /* not JSON line */ }
          }
          result = textParts.length > 0 ? textParts.join('\n') : (stdout.trim() || null);
        } catch {
          result = stdout.trim() || null;
        }

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
        log(`Failed to spawn opencode: ${err.message}`);
        writeOutput({ status: 'error', result: null, error: `Failed to spawn opencode: ${err.message}` });
        reject(err);
      });
    });
  }
}
