/**
 * AgentWire channel — connects NanoClaw to AgentWire via SSE.
 *
 * Receives MCP notifications (email, SMS, talk page messages) from the
 * AgentWire SSE stream and routes them as NanoClaw messages. Outbound
 * messages are posted to the agent's talk page via REST API.
 *
 * Required env vars:
 *   AGENTWIRE_API_KEY   — Bearer token for API auth
 *   AGENTWIRE_AGENT_ID  — The agent's ID on AgentWire
 *   AGENTWIRE_HANDLE    — The agent's handle (e.g. "bpmatt")
 *   AGENTWIRE_URL       — Base URL (default: https://agentwire.run)
 */

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface AgentWireConfig {
  apiKey: string;
  agentId: string;
  handle: string;
  baseUrl: string;
}

// Notification payload types from AgentWire
interface EmailNotification {
  agentId: string;
  emailId: string;
  from: string;
  contactDescription?: string | null;
  agentNotes?: string | null;
  subject: string;
  body: string;
  safetyScore: number;
  safetyFlags: string[];
  status: string;
  receivedAt: string;
}

interface SmsNotification {
  agentId: string;
  agentNotes?: string | null;
  smsId: string;
  from: string;
  body: string;
  media?: { filename: string; contentType: string; size: number }[];
  safetyScore: number;
  safetyFlags: string[];
  status: string;
  receivedAt: string;
}

interface WebhookNotification {
  agentId: string;
  webhookId: string;
  body: string;
  receivedAt: string;
}

export class AgentWireChannel implements Channel {
  name = 'agentwire';

  private config: AgentWireConfig;
  private opts: ChannelOpts;
  private connected = false;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private readonly maxReconnectDelay = 60000;

  constructor(config: AgentWireConfig, opts: ChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.startSSE();
    logger.info(
      { handle: this.config.handle, agentId: this.config.agentId },
      'AgentWire channel connected',
    );
  }

  private async startSSE(): Promise<void> {
    if (!this.connected) return;

    this.abortController = new AbortController();
    const url = `${this.config.baseUrl}/sse?agentId=${this.config.agentId}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `SSE connection failed: ${response.status} ${response.statusText}`,
        );
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      // Reset reconnect delay on successful connection
      this.reconnectDelay = 2000;
      logger.info('AgentWire SSE stream connected');

      await this.readSSEStream(response.body);
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // intentional disconnect

      logger.warn(
        { err: err?.message, delay: this.reconnectDelay },
        'AgentWire SSE connection error, scheduling reconnect',
      );
      this.scheduleReconnect();
    }
  }

  private async readSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // last element is incomplete

        for (const event of events) {
          if (!event.trim()) continue;
          this.handleSSEEvent(event);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      throw err;
    } finally {
      reader.releaseLock();
    }

    // Stream ended — reconnect
    if (this.connected) {
      logger.info('AgentWire SSE stream ended, reconnecting');
      this.scheduleReconnect();
    }
  }

  private handleSSEEvent(raw: string): void {
    // Parse SSE format: "event: type\ndata: json" or just "data: json"
    // Also handle keepalive comments (": keepalive")
    const lines = raw.split('\n');
    let eventType = 'message';
    let data = '';

    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment/keepalive
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data += (data ? '\n' : '') + line.slice(6);
      } else if (line === 'data:') {
        data += '\n';
      }
    }

    if (!data) return;

    // The first SSE event is the endpoint event from MCP SDK
    // Format: data: /messages?sessionId=xxx
    if (eventType === 'endpoint') {
      logger.debug({ endpoint: data }, 'AgentWire SSE session endpoint');
      return;
    }

    // Parse JSON-RPC message
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      logger.debug(
        { data: data.slice(0, 100) },
        'AgentWire: non-JSON SSE data',
      );
      return;
    }

    // Only handle notifications (no id field = notification)
    if (msg.id !== undefined || !msg.method) return;

    this.handleNotification(msg.method, msg.params || {});
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const jid = `agentwire:${this.config.handle}`;
    const timestamp = (params.receivedAt as string) || new Date().toISOString();

    switch (method) {
      case 'notifications/email/inbound': {
        const email = params as unknown as EmailNotification;
        if (email.status !== 'DELIVERED') {
          logger.debug(
            { emailId: email.emailId, status: email.status },
            'Skipping non-delivered email',
          );
          return;
        }
        const content = `[Email from ${email.from}]\nSubject: ${email.subject}\n\n${email.body}`;
        this.deliverMessage(jid, {
          id: email.emailId,
          chat_jid: jid,
          sender: email.from,
          sender_name: email.from,
          content,
          timestamp,
        });
        logger.info(
          { from: email.from, subject: email.subject },
          'AgentWire email received',
        );
        break;
      }

      case 'notifications/sms/inbound': {
        const sms = params as unknown as SmsNotification;
        if (sms.status !== 'DELIVERED') {
          logger.debug(
            { smsId: sms.smsId, status: sms.status },
            'Skipping non-delivered SMS',
          );
          return;
        }
        const mediaNote = sms.media?.length
          ? `\n[${sms.media.length} attachment(s): ${sms.media.map((m) => m.filename).join(', ')}]`
          : '';
        const source = sms.from === 'voice:web' ? 'Talk page' : sms.from;
        const content = `[Message from ${source}] ${sms.body}${mediaNote}`;
        this.deliverMessage(jid, {
          id: sms.smsId,
          chat_jid: jid,
          sender: sms.from,
          sender_name: source,
          content,
          timestamp,
        });
        logger.info({ from: sms.from }, 'AgentWire SMS/talk message received');
        break;
      }

      case 'notifications/webhook/trigger': {
        const webhook = params as unknown as WebhookNotification;
        const content = `[Webhook] ${webhook.body}`;
        this.deliverMessage(jid, {
          id: webhook.webhookId,
          chat_jid: jid,
          sender: 'webhook',
          sender_name: 'Webhook',
          content,
          timestamp,
        });
        logger.info(
          { webhookId: webhook.webhookId },
          'AgentWire webhook received',
        );
        break;
      }

      default:
        logger.debug({ method }, 'AgentWire: unhandled notification');
    }
  }

  private deliverMessage(
    jid: string,
    msg: {
      id: string;
      chat_jid: string;
      sender: string;
      sender_name: string;
      content: string;
      timestamp: string;
    },
  ): void {
    // Store chat metadata
    this.opts.onChatMetadata(
      jid,
      msg.timestamp,
      this.config.handle,
      'agentwire',
      false,
    );

    // Only deliver if group is registered
    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid }, 'Message from unregistered AgentWire JID');
      return;
    }

    this.opts.onMessage(jid, {
      ...msg,
      is_from_me: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Post to the agent's talk page via REST API
    const url = `${this.config.baseUrl}/api/agents/${this.config.handle}/post`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: text.slice(0, 5000) }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(
          { jid, status: response.status, body: body.slice(0, 200) },
          'AgentWire post_message failed',
        );
        return;
      }

      logger.info({ jid, length: text.length }, 'AgentWire message posted');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to post AgentWire message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('agentwire:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    logger.info('AgentWire channel disconnected');
  }

  private scheduleReconnect(): void {
    if (!this.connected) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    // Exponential backoff with jitter
    const jitter = Math.random() * 1000;
    const delay = Math.min(
      this.reconnectDelay + jitter,
      this.maxReconnectDelay,
    );
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay,
    );

    logger.debug({ delay: Math.round(delay) }, 'AgentWire reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startSSE();
    }, delay);
  }
}

registerChannel('agentwire', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'AGENTWIRE_API_KEY',
    'AGENTWIRE_AGENT_ID',
    'AGENTWIRE_HANDLE',
    'AGENTWIRE_URL',
  ]);

  const apiKey =
    process.env.AGENTWIRE_API_KEY || envVars.AGENTWIRE_API_KEY || '';
  const agentId =
    process.env.AGENTWIRE_AGENT_ID || envVars.AGENTWIRE_AGENT_ID || '';
  const handle =
    process.env.AGENTWIRE_HANDLE ||
    envVars.AGENTWIRE_HANDLE ||
    process.env.ASSISTANT_NAME ||
    '';
  const baseUrl =
    process.env.AGENTWIRE_URL ||
    envVars.AGENTWIRE_URL ||
    'https://agentwire.run';

  if (!apiKey || !agentId) {
    // Not configured — skip silently (other channels may handle messaging)
    return null;
  }

  if (!handle) {
    logger.warn('AgentWire: AGENTWIRE_HANDLE not set, cannot start channel');
    return null;
  }

  return new AgentWireChannel({ apiKey, agentId, handle, baseUrl }, opts);
});
