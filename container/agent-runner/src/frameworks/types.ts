/**
 * Framework adapter interface.
 * Each supported agent framework implements this to handle spawning,
 * configuration, and output parsing while sharing the container's
 * IPC/output protocol.
 */

export interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

export interface QueryOptions {
  prompt: string;
  sessionId: string | undefined;
  mcpServerPath: string;
  containerInput: {
    chatJid: string;
    groupFolder: string;
    isMain: boolean;
    isScheduledTask?: boolean;
    assistantName?: string;
    secrets?: Record<string, string>;
    mcpServers?: Record<string, any>;
    replyContext?: { type: string; from: string; subject?: string };
  };
  sdkEnv: Record<string, string | undefined>;
  resumeAt?: string;
}

export interface FrameworkAdapter {
  /** Human-readable name */
  readonly name: string;

  /**
   * Run a single query. Must call writeOutput() with the result.
   * Returns session metadata for the main loop to track.
   */
  runQuery(opts: QueryOptions): Promise<QueryResult>;
}
