import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  SHARED_DIR,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getManifestHash,
  getRegisteredGroup,
  getTaskById,
  setManifestHash,
  updateTask,
} from './db.js';
import { AW_JID_PREFIX, sanitizeHeader } from './channels/agentwire.js';
import type { ReplyContext } from './channels/agentwire.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { applyManifest } from './manifest.js';
import { RegisteredGroup } from './types.js';

/**
 * Auto-create an AgentWire agent for a new group.
 * Uses the global AGENTWIRE_API_KEY from .env.
 * Returns the agentId on success, undefined on failure or if not configured.
 */
async function createAgentWireAgent(
  handle: string,
): Promise<string | undefined> {
  const env = readEnvFile(['AGENTWIRE_API_KEY', 'AGENTWIRE_URL']);
  if (!env.AGENTWIRE_API_KEY) return undefined;

  const url = env.AGENTWIRE_URL || 'https://agentwire.run';
  try {
    const res = await fetch(`${url}/api/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.AGENTWIRE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ handle }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        agentId: string;
        handle: string;
        email: string;
      };
      logger.info(
        { handle, agentId: data.agentId, email: data.email },
        'AgentWire agent created',
      );
      return data.agentId;
    }
    const err = (await res.json()) as { error: string };
    logger.warn(
      { handle, status: res.status, error: err.error },
      'Failed to create AgentWire agent',
    );
    return undefined;
  } catch (err) {
    logger.warn({ handle, err }, 'AgentWire API call failed');
    return undefined;
  }
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendEmailReply: (
    handle: string,
    to: string,
    subject: string,
    body: string,
  ) => Promise<boolean>;
  getReplyContext: (jid: string) => ReplyContext | undefined;
  deliverMessage: (
    jid: string,
    msg: {
      id: string;
      chat_jid: string;
      sender: string;
      sender_name: string;
      content: string;
      timestamp: string;
      is_from_me: boolean;
    },
  ) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'reply' && data.chatJid && data.text) {
                // Authorization: same as message
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Validate reply context against host-stored state (prevent forgery)
                  const storedCtx = deps.getReplyContext(data.chatJid);

                  if (
                    data.replyType === 'email' &&
                    storedCtx?.type === 'email' &&
                    storedCtx.from === data.replyFrom
                  ) {
                    // Validated: container's claim matches host's stored context
                    const handle = data.chatJid.startsWith(AW_JID_PREFIX)
                      ? data.chatJid.slice(AW_JID_PREFIX.length)
                      : '';
                    const rawSubject =
                      data.replySubject || storedCtx.subject || '(no subject)';
                    const subject = sanitizeHeader(
                      rawSubject.startsWith('Re:')
                        ? rawSubject
                        : `Re: ${rawSubject}`,
                    );
                    const to = sanitizeHeader(data.replyFrom);
                    if (handle) {
                      const sent = await deps.sendEmailReply(
                        handle,
                        to,
                        subject,
                        data.text,
                      );
                      if (sent) {
                        logger.info(
                          { handle, to, sourceGroup },
                          'IPC reply sent via email',
                        );
                      } else {
                        // Fallback to talk page
                        await deps.sendMessage(data.chatJid, data.text);
                        logger.warn(
                          { handle, to, sourceGroup },
                          'IPC email reply failed, fell back to talk page',
                        );
                      }
                    } else {
                      await deps.sendMessage(data.chatJid, data.text);
                    }
                  } else if (
                    data.replyType === 'email' &&
                    storedCtx?.type !== 'email'
                  ) {
                    // Container claims email but host has no email context — reject forgery
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        claimedType: data.replyType,
                        actualType: storedCtx?.type,
                      },
                      'IPC reply context mismatch (email claim rejected), routing to talk page',
                    );
                    await deps.sendMessage(data.chatJid, data.text);
                  } else {
                    // Non-email reply: route to talk page / channel
                    await deps.sendMessage(data.chatJid, data.text);
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        replyType: data.replyType,
                      },
                      'IPC reply sent via channel',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reply attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    manifestPath?: string;
    // For create_agent
    handle?: string;
    manifest_yaml?: string;
    system_prompt?: string;
    // For update_skills
    skills?: string[];
    // For deploy_skill
    skill_name?: string;
    source_path?: string;
    // For send_to_agent
    text?: string;
    targetHandle?: string;
    senderHandle?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }

      // Manifest-based registration path
      if (data.manifestPath) {
        try {
          const result = await applyManifest(data.manifestPath, {
            registerGroup: deps.registerGroup,
            getManifestHash,
            setManifestHash,
            getRegisteredGroup,
          });
          logger.info(
            { manifestPath: data.manifestPath, ...result },
            'Manifest applied via IPC',
          );
        } catch (err) {
          logger.warn(
            { manifestPath: data.manifestPath, err },
            'Failed to apply manifest via IPC',
          );
        }
        break;
      }

      // Imperative registration path (unchanged)
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Auto-create AgentWire agent for this group
        const agentwireAgentId = await createAgentWireAgent(data.folder);
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          agentwireAgentId,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'create_agent':
      // Create a new agent from draft files in shared/manifests/{handle}/
      // Main only. Reads wireclaw.yaml from shared dir, validates with Zod,
      // copies to groups/{handle}/, and applies via applyManifest().
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_agent attempt blocked',
        );
        break;
      }

      if (data.handle && isValidGroupFolder(data.handle)) {
        const draftDir = path.join(SHARED_DIR, 'manifests', data.handle);
        const draftManifest = path.join(draftDir, 'wireclaw.yaml');

        if (!fs.existsSync(draftManifest)) {
          logger.warn(
            { handle: data.handle, path: draftManifest },
            'create_agent: manifest not found in shared/manifests/',
          );
          break;
        }

        // Copy draft files to the target group directory
        const targetDir = path.join(GROUPS_DIR, data.handle);
        fs.mkdirSync(targetDir, { recursive: true });

        // Copy all files from draft to target (wireclaw.yaml, claude.md, etc.)
        for (const file of fs.readdirSync(draftDir)) {
          fs.copyFileSync(
            path.join(draftDir, file),
            path.join(targetDir, file),
          );
        }

        // Apply the manifest from the target location (full Zod validation)
        const targetManifest = path.join(targetDir, 'wireclaw.yaml');
        try {
          const result = await applyManifest(targetManifest, {
            registerGroup: deps.registerGroup,
            getManifestHash,
            setManifestHash,
            getRegisteredGroup,
          });

          if (result.status === 'error') {
            // Validation failed — clean up the target directory
            logger.warn(
              { handle: data.handle, error: result.error },
              'create_agent: manifest validation failed, cleaning up',
            );
            fs.rmSync(targetDir, { recursive: true, force: true });
          } else {
            logger.info(
              { ...result, handle: data.handle },
              'create_agent: agent created successfully',
            );
          }
        } catch (err) {
          logger.warn(
            { handle: data.handle, err },
            'create_agent: applyManifest failed',
          );
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
      } else {
        logger.warn(
          { handle: data.handle },
          'create_agent: invalid or missing handle',
        );
      }
      break;

    case 'deploy_skill':
      // Main only: copy a skill from shared workspace to container/skills/
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized deploy_skill attempt blocked',
        );
        break;
      }

      if (
        data.skill_name &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/.test(data.skill_name)
      ) {
        // Look for skill in shared workspace first, then group workspace
        const sharedSkillDir = path.join(SHARED_DIR, 'skills', data.skill_name);
        const groupSkillDir = data.source_path
          ? path.join(
              resolveGroupFolderPath(sourceGroup),
              path.basename(data.source_path),
            )
          : null;
        const sourceDir = fs.existsSync(sharedSkillDir)
          ? sharedSkillDir
          : groupSkillDir && fs.existsSync(groupSkillDir)
            ? groupSkillDir
            : null;

        if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
          logger.warn(
            { skill_name: data.skill_name },
            'deploy_skill: SKILL.md not found in source directory',
          );
          break;
        }

        const targetDir = path.join(
          process.cwd(),
          'container',
          'skills',
          data.skill_name,
        );
        fs.cpSync(sourceDir, targetDir, { recursive: true });
        logger.info(
          { skill_name: data.skill_name, src: sourceDir, dst: targetDir },
          'deploy_skill: skill deployed to container/skills/',
        );
      } else {
        logger.warn(
          { skill_name: data.skill_name },
          'deploy_skill: invalid or missing skill_name',
        );
      }
      break;

    case 'update_skills':
      // Main only: update another group's skills list
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized update_skills attempt blocked',
        );
        break;
      }

      if (data.handle && Array.isArray(data.skills)) {
        // Find the group by handle (folder)
        const allGroups = deps.registeredGroups();
        const targetEntry = Object.entries(allGroups).find(
          ([, g]) => g.folder === data.handle,
        );
        if (targetEntry) {
          const [targetJid, targetGroup] = targetEntry;
          targetGroup.skills = data.skills;
          deps.registerGroup(targetJid, targetGroup);
          logger.info(
            { handle: data.handle, skills: data.skills },
            'Skills updated for group',
          );
        } else {
          logger.warn(
            { handle: data.handle },
            'update_skills: group not found',
          );
        }
      } else {
        logger.warn({ data }, 'update_skills: missing handle or skills array');
      }
      break;

    case 'send_to_agent':
      // Main only: deliver a message to another agent's queue
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized send_to_agent attempt blocked',
        );
        break;
      }
      if (data.targetJid && data.text) {
        const targetGroup = deps.registeredGroups()[data.targetJid];
        if (!targetGroup) {
          logger.warn(
            { targetJid: data.targetJid },
            'send_to_agent: target group not found',
          );
          break;
        }
        const msgId = `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        deps.deliverMessage(data.targetJid, {
          id: msgId,
          chat_jid: data.targetJid,
          sender: `${data.senderHandle || sourceGroup}@wireclaw`,
          sender_name: data.senderHandle || sourceGroup,
          content: `[From agent ${data.senderHandle || sourceGroup}] ${data.text}`,
          timestamp: new Date().toISOString(),
          is_from_me: false,
        });
        logger.info(
          {
            from: sourceGroup,
            to: data.targetHandle,
            targetJid: data.targetJid,
          },
          'Inter-agent message delivered',
        );
      }
      break;

    case 'self_reminder': {
      // Agent-initiated reminder: schedule a delayed IPC reminder injection
      if (data.text && data.groupFolder) {
        const delayMs = ((data as { delay_seconds?: number }).delay_seconds || 60) * 1000;
        const category = (data as { category?: string }).category || 'self';
        const groupFolder = data.groupFolder;

        setTimeout(() => {
          // Write reminder directly to the container's IPC input dir
          const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
          try {
            fs.mkdirSync(inputDir, { recursive: true });
            const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
            const filepath = path.join(inputDir, filename);
            const tempPath = `${filepath}.tmp`;
            fs.writeFileSync(
              tempPath,
              JSON.stringify({ type: 'reminder', category, text: data.text }),
            );
            fs.renameSync(tempPath, filepath);
            logger.info(
              { groupFolder, category, delayMs },
              'Self-reminder delivered',
            );
          } catch (err) {
            logger.warn({ groupFolder, err }, 'Failed to deliver self-reminder');
          }
        }, delayMs);

        logger.info(
          { groupFolder, category, delayMs },
          'Self-reminder scheduled',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
