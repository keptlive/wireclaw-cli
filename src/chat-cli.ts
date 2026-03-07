#!/usr/bin/env tsx
/**
 * WireClaw Chat CLI — live interactive chat with an agent group.
 *
 * Usage:
 *   npx tsx src/chat-cli.ts <group-folder> [initial-message]
 *
 * Examples:
 *   npx tsx src/chat-cli.ts test-agent
 *   npx tsx src/chat-cli.ts test-agent "Hello, what can you do?"
 *
 * Type messages and press Enter. The agent response streams back.
 * Commands:
 *   /quit   — exit
 *   /session — show current session ID
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, TIMEZONE } from './config.js';
import { initDatabase } from './db.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { ContainerInput, ContainerOutput, runContainerAgent } from './container-runner.js';
import { RegisteredGroup } from './types.js';
import { getAllRegisteredGroups, getSession, setSession } from './db.js';

const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function printAgent(text: string): void {
  // Strip <internal>...</internal> blocks
  const clean = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  if (clean) {
    console.log(`\n${GREEN}${BOLD}Agent:${RESET} ${clean}\n`);
  }
}

function printSystem(text: string): void {
  console.log(`${DIM}${text}${RESET}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: npx tsx src/chat-cli.ts <group-folder> [initial-message]');
    console.log('');
    console.log('  group-folder   Folder name of the registered group (e.g. test-agent)');
    console.log('  initial-message   Optional first message to send');
    process.exit(1);
  }

  const groupFolder = args[0];
  const initialMessage = args.slice(1).join(' ') || null;

  initDatabase();

  // Find the group in DB
  const allGroups = getAllRegisteredGroups();
  let group: RegisteredGroup | undefined;
  let chatJid: string | undefined;

  for (const [jid, g] of Object.entries(allGroups)) {
    if (g.folder === groupFolder) {
      group = g;
      chatJid = jid;
      break;
    }
  }

  if (!group || !chatJid) {
    console.error(`Group "${groupFolder}" not found in database.`);
    console.error('Registered groups:');
    for (const [jid, g] of Object.entries(allGroups)) {
      console.error(`  ${g.folder} (${g.name}) — ${jid}`);
    }
    process.exit(1);
  }

  printSystem(`Group: ${group.name} (${chatJid})`);
  printSystem(`Model: ${group.model || 'default'}`);
  if (group.containerConfig?.mcpServers) {
    printSystem(`MCP servers: ${Object.keys(group.containerConfig.mcpServers).join(', ')}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let sessionId = getSession(groupFolder);
  if (sessionId) {
    printSystem(`Resuming session: ${sessionId}`);
  }

  let containerRunning = false;
  let ipcInputDir: string | null = null;
  let messageCounter = 0;

  const sendIpcMessage = (text: string) => {
    if (!ipcInputDir) return false;
    messageCounter++;
    const filename = `${Date.now()}-${messageCounter.toString().padStart(4, '0')}.json`;
    const filePath = path.join(ipcInputDir, filename);
    fs.writeFileSync(filePath, JSON.stringify({ type: 'message', text }));
    return true;
  };

  const closeContainer = () => {
    if (!ipcInputDir) return;
    const sentinel = path.join(ipcInputDir, '_close');
    fs.writeFileSync(sentinel, '');
  };

  const runAgent = async (prompt: string) => {
    containerRunning = true;
    printSystem('Agent thinking...');

    const output = await runContainerAgent(
      group!,
      {
        prompt,
        sessionId,
        groupFolder,
        chatJid: chatJid!,
        isMain: false,
        assistantName: 'Agent',
      },
      (proc, containerName) => {
        // Set up IPC input dir for follow-up messages
        ipcInputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
        fs.mkdirSync(ipcInputDir, { recursive: true });
        printSystem(`Container: ${containerName}`);
      },
      async (result: ContainerOutput) => {
        if (result.newSessionId) {
          sessionId = result.newSessionId;
          setSession(groupFolder, sessionId);
        }
        if (result.result) {
          printAgent(result.result);
          promptUser();
        }
      },
    );

    containerRunning = false;

    if (output.newSessionId) {
      sessionId = output.newSessionId;
      setSession(groupFolder, sessionId);
    }

    if (output.status === 'error') {
      console.error(`\n${BOLD}Error:${RESET} ${output.error}`);
    }
  };

  const promptUser = () => {
    rl.question(`${BLUE}You:${RESET} `, async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        promptUser();
        return;
      }

      if (trimmed === '/quit' || trimmed === '/exit') {
        printSystem('Closing container...');
        closeContainer();
        rl.close();
        // Give container time to exit cleanly
        setTimeout(() => process.exit(0), 2000);
        return;
      }

      if (trimmed === '/session') {
        printSystem(`Session ID: ${sessionId || 'none'}`);
        promptUser();
        return;
      }

      // If container is running, pipe via IPC
      if (containerRunning && ipcInputDir) {
        if (sendIpcMessage(trimmed)) {
          printSystem('(piped to active container)');
          // Don't prompt — wait for agent response callback
          return;
        }
      }

      // Start new container run
      await runAgent(trimmed);

      // After container exits, prompt for next message (starts new container)
      if (!containerRunning) {
        promptUser();
      }
    });
  };

  // Handle Ctrl+C
  rl.on('close', () => {
    closeContainer();
    printSystem('Bye!');
    setTimeout(() => process.exit(0), 1000);
  });

  // Start
  if (initialMessage) {
    await runAgent(initialMessage);
    promptUser();
  } else {
    console.log(`\n${BOLD}Chat with ${group.name}${RESET}`);
    console.log(`Type a message and press Enter. /quit to exit.\n`);
    promptUser();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
