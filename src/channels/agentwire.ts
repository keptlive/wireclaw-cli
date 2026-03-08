/**
 * AgentWire channel — connects WireClaw to AgentWire via SSE.
 *
 * Manages SSE connections for ALL registered groups with agentwire: JIDs.
 * Each agent gets its own SSE stream. Inbound notifications (email, SMS,
 * talk page, webhooks) are routed as WireClaw messages. Outbound messages
 * are posted to the agent's talk page via REST API.
 *
 * Required env vars:
 *   AGENTWIRE_API_KEY   — Bearer token for API auth (shared across agents)
 *   AGENTWIRE_URL       — Base URL (default: https://agentwire.run)
 *
 * Per-agent config comes from the registered group's agentwireAgentId field,
 * set automatically by the manifest system when creating agents.
 */

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup } from '../types.js';

/** JID prefix for AgentWire agents */
export const AW_JID_PREFIX = 'agentwire:';

export interface ReplyContext {
  type: 'email' | 'talk' | 'sms' | 'webhook';
  from: string;
  subject?: string;
}

/** Strip CRLF and control chars to prevent email header injection */
export function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n\x00-\x1f]/g, '');
}

interface AgentSSEConnection {
  handle: string;
  agentId: string;
  abortController: AbortController;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
}

// Notification payload types from AgentWire
interface EmailNotification {
  agentId: string;
  emailId: string;
  from: string;
  subject: string;
  body: string;
  safetyScore: number;
  safetyFlags: string[];
  status: string;
  receivedAt: string;
}

interface SmsNotification {
  agentId: string;
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

  private apiKey: string;
  private baseUrl: string;
  private opts: ChannelOpts;
  private connected = false;
  private connections = new Map<string, AgentSSEConnection>(); // jid → connection
  private replyContexts = new Map<string, ReplyContext>(); // jid → last inbound context
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly maxReconnectDelay = 60000;

  constructor(apiKey: string, baseUrl: string, opts: ChannelOpts) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;

    // Connect SSE for all registered groups with agentwire: JIDs
    this.syncConnections();

    // Periodically check for new/removed groups (e.g. after manifest apply)
    this.syncInterval = setInterval(() => this.syncConnections(), 30_000);

    const count = this.connections.size;
    logger.info({ agentCount: count }, 'AgentWire channel connected');
  }

  /**
   * Scan registered groups and ensure we have an SSE connection for each
   * agentwire: group that has an agentId. Connect new ones, disconnect removed ones.
   */
  private syncConnections(): void {
    if (!this.connected) return;

    const groups = this.opts.registeredGroups();
    const activeJids = new Set<string>();

    for (const [jid, group] of Object.entries(groups)) {
      if (!jid.startsWith(AW_JID_PREFIX)) continue;
      if (!group.agentwireAgentId) continue;

      activeJids.add(jid);

      // Already connected?
      if (this.connections.has(jid)) continue;

      // Extract handle from JID
      const handle = jid.slice(AW_JID_PREFIX.length);

      const conn: AgentSSEConnection = {
        handle,
        agentId: group.agentwireAgentId,
        abortController: new AbortController(),
        reconnectTimer: null,
        reconnectDelay: 2000,
      };
      this.connections.set(jid, conn);

      logger.info(
        { handle, agentId: group.agentwireAgentId },
        'Connecting SSE for agent',
      );
      this.startSSE(jid, conn);
    }

    // Disconnect agents that are no longer registered
    for (const [jid, conn] of this.connections) {
      if (!activeJids.has(jid)) {
        logger.info(
          { handle: conn.handle },
          'Disconnecting SSE for removed agent',
        );
        this.disconnectAgent(jid);
      }
    }
  }

  private async startSSE(jid: string, conn: AgentSSEConnection): Promise<void> {
    if (!this.connected) return;

    const url = `${this.baseUrl}/sse?agentId=${conn.agentId}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: conn.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      conn.reconnectDelay = 2000;
      logger.info({ handle: conn.handle }, 'AgentWire SSE stream connected');

      await this.readSSEStream(jid, conn, response.body);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;

      logger.warn(
        { handle: conn.handle, err: err?.message, delay: conn.reconnectDelay },
        'AgentWire SSE error, scheduling reconnect',
      );
      this.scheduleReconnect(jid, conn);
    }
  }

  private async readSSEStream(
    jid: string,
    conn: AgentSSEConnection,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;
          this.handleSSEEvent(jid, conn, event);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      throw err;
    } finally {
      reader.releaseLock();
    }

    // Stream ended — reconnect
    if (this.connected && this.connections.has(jid)) {
      logger.info({ handle: conn.handle }, 'SSE stream ended, reconnecting');
      this.scheduleReconnect(jid, conn);
    }
  }

  private handleSSEEvent(
    jid: string,
    conn: AgentSSEConnection,
    raw: string,
  ): void {
    const lines = raw.split('\n');
    let eventType = 'message';
    let data = '';

    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        data += (data ? '\n' : '') + line.slice(6);
      } else if (line === 'data:') {
        data += '\n';
      }
    }

    if (!data) return;
    if (eventType === 'endpoint') return;

    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.id !== undefined || !msg.method) return;
    this.handleNotification(jid, conn, msg.method, msg.params || {});
  }

  private handleNotification(
    jid: string,
    conn: AgentSSEConnection,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const timestamp = (params.receivedAt as string) || new Date().toISOString();

    switch (method) {
      case 'notifications/email/inbound': {
        const email = params as unknown as EmailNotification;
        if (email.status !== 'DELIVERED') return;
        this.replyContexts.set(jid, {
          type: 'email',
          from: email.from,
          subject: email.subject,
        });
        const content = `[Email from ${email.from}]\nSubject: ${email.subject}\n\n${email.body}`;
        this.deliverMessage(jid, conn.handle, {
          id: email.emailId,
          chat_jid: jid,
          sender: email.from,
          sender_name: email.from,
          content,
          timestamp,
        });
        logger.info(
          { handle: conn.handle, from: email.from, subject: email.subject },
          'AgentWire email received',
        );
        break;
      }

      case 'notifications/sms/inbound': {
        const sms = params as unknown as SmsNotification;
        if (sms.status !== 'DELIVERED') return;
        this.replyContexts.set(jid, {
          type: sms.from === 'voice:web' ? 'talk' : 'sms',
          from: sms.from,
        });
        const mediaNote = sms.media?.length
          ? `\n[${sms.media.length} attachment(s): ${sms.media.map((m) => m.filename).join(', ')}]`
          : '';
        const source = sms.from === 'voice:web' ? 'Talk page' : sms.from;
        const content = `[Message from ${source}] ${sms.body}${mediaNote}`;
        this.deliverMessage(jid, conn.handle, {
          id: sms.smsId,
          chat_jid: jid,
          sender: sms.from,
          sender_name: source,
          content,
          timestamp,
        });
        logger.info(
          { handle: conn.handle, from: sms.from },
          'AgentWire message received',
        );
        break;
      }

      case 'notifications/webhook/trigger': {
        const webhook = params as unknown as WebhookNotification;
        this.replyContexts.set(jid, {
          type: 'webhook',
          from: 'webhook',
        });
        this.deliverMessage(jid, conn.handle, {
          id: webhook.webhookId,
          chat_jid: jid,
          sender: 'webhook',
          sender_name: 'Webhook',
          content: `[Webhook] ${webhook.body}`,
          timestamp,
        });
        logger.info({ handle: conn.handle }, 'AgentWire webhook received');
        break;
      }

      default:
        logger.debug(
          { method, handle: conn.handle },
          'AgentWire: unhandled notification',
        );
    }
  }

  private deliverMessage(
    jid: string,
    handle: string,
    msg: {
      id: string;
      chat_jid: string;
      sender: string;
      sender_name: string;
      content: string;
      timestamp: string;
    },
  ): void {
    this.opts.onChatMetadata(jid, msg.timestamp, handle, 'agentwire', false);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid }, 'Message from unregistered AgentWire JID');
      return;
    }

    this.opts.onMessage(jid, { ...msg, is_from_me: false });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Extract handle from JID (agentwire:handle → handle)
    const handle = jid.slice(AW_JID_PREFIX.length);
    if (!handle) {
      logger.warn({ jid }, 'Cannot extract handle from AgentWire JID');
      return;
    }

    const ctx = this.replyContexts.get(jid);
    const trimmed = text.slice(0, 5000);

    // Route email replies via /send-email endpoint
    if (ctx?.type === 'email' && ctx.from) {
      const rawSubject = ctx.subject || '(no subject)';
      const replySubject = sanitizeHeader(
        rawSubject.startsWith('Re:') ? rawSubject : `Re: ${rawSubject}`,
      );
      try {
        const emailUrl = `${this.baseUrl}/api/agents/${handle}/send-email`;
        const emailRes = await fetch(emailUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: ctx.from,
            subject: replySubject,
            body: trimmed,
          }),
        });

        if (emailRes.ok) {
          logger.info(
            { handle, to: ctx.from, subject: replySubject },
            'AgentWire email reply sent',
          );
          return;
        }

        const errBody = await emailRes.text().catch(() => '');
        logger.warn(
          { handle, status: emailRes.status, body: errBody.slice(0, 200) },
          'AgentWire email send failed, falling back to talk page',
        );
      } catch (err) {
        logger.warn(
          { handle, err },
          'AgentWire email send error, falling back to talk page',
        );
      }
    }

    // Default: post to talk page
    const url = `${this.baseUrl}/api/agents/${handle}/post`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: trimmed }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(
          { handle, status: response.status, body: body.slice(0, 200) },
          'AgentWire post_message failed',
        );
        return;
      }

      logger.info({ handle, length: text.length }, 'AgentWire message posted');
    } catch (err) {
      logger.error({ handle, err }, 'Failed to post AgentWire message');
    }
  }

  /** Get the current reply context for a JID (used by container-runner) */
  getReplyContext(jid: string): ReplyContext | undefined {
    return this.replyContexts.get(jid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(AW_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    for (const jid of [...this.connections.keys()]) {
      this.disconnectAgent(jid);
    }

    logger.info('AgentWire channel disconnected');
  }

  private disconnectAgent(jid: string): void {
    const conn = this.connections.get(jid);
    if (!conn) return;

    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.abortController.abort();
    this.connections.delete(jid);
    this.replyContexts.delete(jid);
  }

  private scheduleReconnect(jid: string, conn: AgentSSEConnection): void {
    if (!this.connected || !this.connections.has(jid)) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);

    const jitter = Math.random() * 1000;
    const delay = Math.min(
      conn.reconnectDelay + jitter,
      this.maxReconnectDelay,
    );
    conn.reconnectDelay = Math.min(
      conn.reconnectDelay * 2,
      this.maxReconnectDelay,
    );

    // Create a new abort controller for the reconnection
    conn.abortController = new AbortController();

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.startSSE(jid, conn);
    }, delay);
  }
}

registerChannel('agentwire', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['AGENTWIRE_API_KEY', 'AGENTWIRE_URL']);

  const apiKey =
    process.env.AGENTWIRE_API_KEY || envVars.AGENTWIRE_API_KEY || '';
  const baseUrl =
    process.env.AGENTWIRE_URL ||
    envVars.AGENTWIRE_URL ||
    'https://agentwire.run';

  if (!apiKey) {
    return null;
  }

  return new AgentWireChannel(apiKey, baseUrl, opts);
});
