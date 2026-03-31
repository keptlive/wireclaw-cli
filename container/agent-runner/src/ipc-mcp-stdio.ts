/**
 * Stdio MCP Server for WireClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.WIRECLAW_CHAT_JID!;
const groupFolder = process.env.WIRECLAW_GROUP_FOLDER!;
const isMain = process.env.WIRECLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'wireclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'manage_skills',
  `View and update skills for any agent group. Main group only.

Read /workspace/ipc/skills_snapshot.json first to see available skills and each group's current skills.

Use action "list" to see skills (no IPC write needed — just read the snapshot file).
Use action "set" with a handle and skills array to update a group's skills.
Use "*" in the skills array to give a group access to all available skills.
Use an empty array to remove all skills from a group.

Changes take effect on the group's next container invocation.`,
  {
    action: z.enum(['list', 'set']).describe('"list" to view, "set" to update'),
    handle: z.string().optional().describe('Target group handle (required for "set")'),
    skills: z.array(z.string()).optional().describe('New skills list (required for "set"). Use ["*"] for all.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can manage skills.' }],
        isError: true,
      };
    }

    if (args.action === 'list') {
      const snapshotPath = path.join(IPC_DIR, 'skills_snapshot.json');
      if (!fs.existsSync(snapshotPath)) {
        return {
          content: [{ type: 'text' as const, text: 'No skills snapshot found. Skills data will be available after next container invocation.' }],
        };
      }
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(snapshot, null, 2) }],
      };
    }

    // action === 'set'
    if (!args.handle || !args.skills) {
      return {
        content: [{ type: 'text' as const, text: 'handle and skills are required for "set" action.' }],
        isError: true,
      };
    }

    const data = {
      type: 'update_skills',
      handle: args.handle,
      skills: args.skills,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const skillsDesc = args.skills.includes('*')
      ? 'all available skills'
      : args.skills.length === 0
        ? 'no skills'
        : args.skills.join(', ');
    return {
      content: [{ type: 'text' as const, text: `Skills for "${args.handle}" updated to: ${skillsDesc}. Takes effect on next invocation.` }],
    };
  },
);

server.tool(
  'create_agent',
  `Create a new WireClaw agent from draft files in /workspace/shared/manifests/{handle}/. Main group only.

Before calling this tool, write these files using the Write tool:
1. /workspace/shared/manifests/{handle}/wireclaw.yaml — the agent manifest
2. /workspace/shared/manifests/{handle}/claude.md — the system prompt

Then call this tool with just the handle. The host will validate the manifest, copy files to groups/{handle}/, register the agent on AgentWire, and send an intro email.

Handle rules: lowercase alphanumeric, hyphens, underscores. Regex: ^[a-z0-9][a-z0-9_-]{0,63}$`,
  {
    handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('Agent handle (becomes {handle}@agentwire.email)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can create agents.' }],
        isError: true,
      };
    }

    // Verify draft files exist before sending IPC
    const draftDir = `/workspace/shared/manifests/${args.handle}`;
    const manifestPath = `${draftDir}/wireclaw.yaml`;
    if (!fs.existsSync(manifestPath)) {
      return {
        content: [{ type: 'text' as const, text: `Draft manifest not found at ${manifestPath}. Write the wireclaw.yaml file there first, then call this tool.` }],
        isError: true,
      };
    }

    const data = {
      type: 'create_agent',
      handle: args.handle,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Agent "${args.handle}" creation requested. The host will validate the manifest from shared/manifests/${args.handle}/, copy to groups/${args.handle}/, and register at ${args.handle}@agentwire.email. Check logs for result.` }],
    };
  },
);

server.tool(
  'system_health',
  `Run a VPS health check. Returns disk usage, memory, uptime, Docker containers, systemd service status, and top processes. Main group only. Results are returned asynchronously — check /workspace/ipc/output/ for the health-*.json file after a few seconds.`,
  {},
  async () => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can run system health checks.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'system_health',
      timestamp: new Date().toISOString(),
    });

    // Poll for output file (host writes to /workspace/ipc/output/)
    const outputDir = '/workspace/ipc/output';
    const startTime = Date.now();
    const timeout = 15000;

    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir).filter(f => f.startsWith('health-'));
        if (files.length > 0) {
          // Read and delete the newest result
          const latest = files.sort().pop()!;
          const resultPath = path.join(outputDir, latest);
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          return {
            content: [{ type: 'text' as const, text: result.result }],
          };
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    return {
      content: [{ type: 'text' as const, text: 'Health check timed out. The host may be busy — try again shortly.' }],
      isError: true,
    };
  },
);

server.tool(
  'deploy_skill',
  `Deploy a skill to the host's container/skills/ directory so all agents can use it. Main group only.

Before calling this tool, write the skill files to /workspace/shared/skills/{skill_name}/:
1. /workspace/shared/skills/{skill_name}/SKILL.md — the skill file (required)
2. Any bundled resources (scripts/, references/, agents/, assets/)

Then call this tool with the skill_name. The host will copy it to container/skills/.
After deployment, assign it to agents using manage_skills.`,
  {
    skill_name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).describe('Skill name (kebab-case, e.g. "data-analyzer")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can deploy skills.' }],
        isError: true,
      };
    }

    // Verify skill files exist
    const skillDir = `/workspace/shared/skills/${args.skill_name}`;
    const skillMd = `${skillDir}/SKILL.md`;
    if (!fs.existsSync(skillMd)) {
      return {
        content: [{ type: 'text' as const, text: `SKILL.md not found at ${skillMd}. Write the skill files there first, then call this tool.` }],
        isError: true,
      };
    }

    const data = {
      type: 'deploy_skill',
      skill_name: args.skill_name,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Skill "${args.skill_name}" deployment requested. The host will copy it from shared/skills/${args.skill_name}/ to container/skills/. Use manage_skills to assign it to specific agents.` }],
    };
  },
);

server.tool(
  'send_to_agent',
  `Send a message to another agent by handle. Main group only.

This delivers the message as if it came from an external source, triggering the target agent's container.
Read /workspace/ipc/registered_agents.json to discover available agents and their handles.

Example: send_to_agent({ target_handle: "research", text: "Please analyze the latest papers on..." })`,
  {
    target_handle: z.string().describe('Handle of the target agent (e.g. "research")'),
    text: z.string().describe('Message to send to the agent'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can send messages to other agents.' }],
        isError: true,
      };
    }

    // Look up target JID from registered_agents.json
    const agentsFile = path.join(IPC_DIR, 'registered_agents.json');
    if (!fs.existsSync(agentsFile)) {
      return {
        content: [{ type: 'text' as const, text: 'registered_agents.json not found. Wait for next container invocation.' }],
        isError: true,
      };
    }

    let targetJid: string | null = null;
    try {
      const data = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
      const agent = data.agents?.find((a: { handle: string }) => a.handle === args.target_handle);
      if (agent) targetJid = agent.jid;
    } catch {
      return {
        content: [{ type: 'text' as const, text: 'Failed to read registered_agents.json.' }],
        isError: true,
      };
    }

    if (!targetJid) {
      return {
        content: [{ type: 'text' as const, text: `Agent "${args.target_handle}" not found. Check registered_agents.json for available agents.` }],
        isError: true,
      };
    }

    const ipcData = {
      type: 'send_to_agent',
      targetJid,
      targetHandle: args.target_handle,
      text: args.text,
      senderHandle: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, ipcData);

    return {
      content: [{ type: 'text' as const, text: `Message sent to ${args.target_handle}.` }],
    };
  },
);

// Reply context from environment (set by agent-runner based on inbound channel)
const replyType = process.env.WIRECLAW_REPLY_TYPE || '';
const replyFrom = process.env.WIRECLAW_REPLY_FROM || '';
const replySubject = process.env.WIRECLAW_REPLY_SUBJECT || '';

server.tool(
  'reply',
  `Send a reply that automatically routes to the channel the user contacted you from. If they emailed you, this replies by email. If they messaged on the talk page, this posts to the talk page. Use this instead of send_message when responding to a user's inbound message.

Current reply context: ${replyType ? `type=${replyType}, from=${replyFrom}${replySubject ? `, subject=${replySubject}` : ''}` : 'none (will post to talk page)'}`,
  {
    text: z.string().describe('The reply text to send'),
  },
  async (args) => {
    const data: Record<string, string> = {
      type: 'reply',
      chatJid,
      text: args.text,
      groupFolder,
      replyType,
      replyFrom,
      replySubject,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const routeDesc = replyType === 'email'
      ? `email to ${replyFrom}`
      : 'talk page';
    return { content: [{ type: 'text' as const, text: `Reply sent via ${routeDesc}.` }] };
  },
);

// --- Self-reminders: agents can schedule their own system reminders ---

server.tool(
  'set_reminder',
  `Schedule a system reminder for yourself. The reminder will be injected into your conversation as a <system-reminder> message after the specified delay. Use this to:
- Set a timer to check back on something ("remind me in 5 minutes to check the build")
- Keep yourself on track during long tasks
- Schedule follow-up actions

The reminder fires once. To repeat, call set_reminder again from within the reminder handler.`,
  {
    text: z.string().describe('The reminder text you want to receive'),
    delay_seconds: z.number().min(10).max(3600).describe('Seconds until the reminder fires (10-3600)'),
    category: z.string().optional().describe('Reminder category tag (default: self)'),
  },
  async (args) => {
    const category = args.category || 'self';
    const data = {
      type: 'self_reminder',
      text: args.text,
      delay_seconds: args.delay_seconds,
      category,
      groupFolder,
      chatJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text' as const,
        text: `Reminder scheduled: "${args.text}" in ${args.delay_seconds}s (category: ${category})`,
      }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
