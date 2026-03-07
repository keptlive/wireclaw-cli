/**
 * Declarative YAML Group Manifests for WireClaw
 *
 * Parses, validates, and applies wireclaw.yaml manifests to register groups.
 * Manifests are an "apply" operation: DB remains source of truth.
 * Idempotent via manifest_hash tracking.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parse as parseYaml } from 'yaml';
import * as z from 'zod';

import { GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { McpServerConfig, RegisteredGroup } from './types.js';

// --- Zod schema ---

const McpServerSpec = z.union([
  z.string(), // shorthand: "npx -y @mcp/server-github"
  z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    type: z.enum(['sse', 'stdio']).default('stdio'),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
]);

const GroupManifestSchema = z.object({
  version: z.string(),
  identity: z.object({
    group_name: z.string().min(1),
    handle: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    description: z.string().optional(),
  }),
  context: z.object({
    system_prompt: z.string().optional(),
    model: z.string().optional(),
  }).optional(),
  channel_binding: z.object({
    jid: z.string().min(1),
    trigger: z.string().min(1),
    requires_trigger: z.boolean().default(true),
  }).optional(),
  dependencies: z.object({
    system_packages: z.array(z.string()).optional(),
    env_vars: z.array(z.string()).optional(),
    mcp_servers: z.record(z.string(), McpServerSpec).optional(),
  }).optional(),
  container: z.object({
    timeout: z.number().positive().optional(),
    additional_mounts: z.array(z.object({
      host_path: z.string(),
      container_path: z.string().optional(),
      readonly: z.boolean().default(true),
    })).optional(),
  }).optional(),
  skills: z.array(z.string()).optional(),
});

export type GroupManifest = z.infer<typeof GroupManifestSchema>;

// --- Core functions ---

/**
 * Load and validate a manifest from a YAML file.
 */
export function loadManifest(filePath: string): GroupManifest {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  return GroupManifestSchema.parse(parsed);
}

/**
 * Compute a hash of the manifest file contents for idempotency.
 */
export function manifestHash(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Discover all manifest files from standard locations.
 * Scans groups/{handle}/wireclaw.yaml and manifests/*.yaml
 */
export function discoverManifests(): string[] {
  const projectRoot = process.cwd();
  const files: string[] = [];

  // Scan groups/*/wireclaw.yaml
  const groupsDir = GROUPS_DIR;
  if (fs.existsSync(groupsDir)) {
    for (const entry of fs.readdirSync(groupsDir)) {
      const manifestPath = path.join(groupsDir, entry, 'wireclaw.yaml');
      if (fs.existsSync(manifestPath)) {
        files.push(manifestPath);
      }
    }
  }

  // Scan manifests/*.yaml
  const manifestsDir = path.join(projectRoot, 'manifests');
  if (fs.existsSync(manifestsDir)) {
    for (const entry of fs.readdirSync(manifestsDir)) {
      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        files.push(path.join(manifestsDir, entry));
      }
    }
  }

  return files;
}

/**
 * Normalize an MCP server spec from shorthand string to full object.
 */
export function normalizeMcpServer(
  spec: string | { command?: string; args?: string[]; type?: string; url?: string; headers?: Record<string, string>; env?: Record<string, string> },
): McpServerConfig {
  if (typeof spec === 'string') {
    const parts = spec.split(/\s+/);
    return {
      command: parts[0],
      args: parts.slice(1),
      type: 'stdio',
    };
  }
  return {
    command: spec.command,
    args: spec.args,
    type: (spec.type as 'sse' | 'stdio') || 'stdio',
    url: spec.url,
    headers: spec.headers,
    env: spec.env,
  };
}

/**
 * Convert a manifest to a RegisteredGroup + jid.
 */
export function manifestToRegisteredGroup(
  manifest: GroupManifest,
  agentwireAgentId?: string,
): { jid: string; group: RegisteredGroup } {
  const handle = manifest.identity.handle;
  const jid = manifest.channel_binding?.jid || `aw:${handle}`;

  const mcpServers: Record<string, McpServerConfig> | undefined =
    manifest.dependencies?.mcp_servers
      ? Object.fromEntries(
          Object.entries(manifest.dependencies.mcp_servers).map(
            ([name, spec]) => [name, normalizeMcpServer(spec)],
          ),
        )
      : undefined;

  const group: RegisteredGroup = {
    name: manifest.identity.group_name,
    folder: handle,
    trigger: manifest.channel_binding?.trigger || `@${handle}`,
    added_at: new Date().toISOString(),
    containerConfig: {
      timeout: manifest.container?.timeout,
      additionalMounts: manifest.container?.additional_mounts?.map((m) => ({
        hostPath: m.host_path,
        containerPath: m.container_path,
        readonly: m.readonly,
      })),
      mcpServers,
      envVars: manifest.dependencies?.env_vars,
    },
    requiresTrigger: manifest.channel_binding?.requires_trigger ?? true,
    agentwireAgentId,
    model: manifest.context?.model,
  };

  return { jid, group };
}

/**
 * Create an AgentWire agent for the manifest handle.
 * Returns agentId on success, undefined if not configured or handle taken.
 */
async function createAgentWireAgent(handle: string): Promise<{ agentId?: string; handleTaken?: boolean }> {
  const env = readEnvFile(['AGENTWIRE_API_KEY', 'AGENTWIRE_URL']);
  if (!env.AGENTWIRE_API_KEY) return {};

  const url = env.AGENTWIRE_URL || 'https://agentwire.run';
  try {
    const res = await fetch(`${url}/api/agents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.AGENTWIRE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ handle }),
    });
    if (res.ok) {
      const data = await res.json() as { agentId: string; handle: string; email: string };
      logger.info({ handle, agentId: data.agentId, email: data.email }, 'AgentWire agent created');
      return { agentId: data.agentId };
    }
    const err = await res.json() as { error: string };
    if (res.status === 409 || err.error?.toLowerCase().includes('taken')) {
      return { handleTaken: true };
    }
    logger.warn({ handle, status: res.status, error: err.error }, 'Failed to create AgentWire agent');
    return {};
  } catch (err) {
    logger.warn({ handle, err }, 'AgentWire API call failed');
    return {};
  }
}

/**
 * Setup the group folder: create directories, copy CLAUDE.md, sync skills.
 */
function setupGroupFolder(
  manifest: GroupManifest,
  manifestDir: string,
): void {
  const groupDir = path.join(GROUPS_DIR, manifest.identity.handle);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy system prompt (CLAUDE.md) if specified
  if (manifest.context?.system_prompt) {
    const promptSrc = path.resolve(manifestDir, manifest.context.system_prompt);
    if (fs.existsSync(promptSrc)) {
      const promptDst = path.join(groupDir, 'CLAUDE.md');
      fs.copyFileSync(promptSrc, promptDst);
      logger.info({ src: promptSrc, dst: promptDst }, 'Copied system prompt');
    } else {
      logger.warn({ path: promptSrc }, 'System prompt file not found');
    }
  }

  // Copy referenced skills into container/skills/ if not already present
  if (manifest.skills && manifest.skills.length > 0) {
    const skillsSrc = path.join(process.cwd(), 'container', 'skills');
    for (const skill of manifest.skills) {
      const skillDir = path.join(skillsSrc, skill);
      if (!fs.existsSync(skillDir)) {
        logger.warn({ skill }, 'Skill directory not found in container/skills/');
      }
    }
  }
}

export interface ApplyDeps {
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getManifestHash: (jid: string) => string | undefined;
  setManifestHash: (jid: string, hash: string) => void;
  getRegisteredGroup: (jid: string) => (RegisteredGroup & { jid: string }) | undefined;
}

export interface ApplyResult {
  status: 'created' | 'updated' | 'unchanged' | 'error';
  handle: string;
  jid: string;
  error?: string;
  handleTaken?: boolean;
}

/**
 * Apply a manifest: create AgentWire agent, upsert into DB, setup folder.
 * Idempotent — skips if manifest hash unchanged.
 */
export async function applyManifest(
  manifestPath: string,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  let manifest: GroupManifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', handle: '?', jid: '?', error: `Parse error: ${msg}` };
  }

  const handle = manifest.identity.handle;
  if (!isValidGroupFolder(handle)) {
    return { status: 'error', handle, jid: '?', error: `Invalid handle: ${handle}` };
  }

  const hash = manifestHash(manifestPath);
  const tentativeJid = manifest.channel_binding?.jid || `aw:${handle}`;

  // Check idempotency
  const existingHash = deps.getManifestHash(tentativeJid);
  if (existingHash === hash) {
    return { status: 'unchanged', handle, jid: tentativeJid };
  }

  // Check if group already exists (update path)
  const existing = deps.getRegisteredGroup(tentativeJid);
  let agentwireAgentId = existing?.agentwireAgentId;

  if (!agentwireAgentId) {
    // Create AgentWire agent
    const result = await createAgentWireAgent(handle);
    if (result.handleTaken) {
      return { status: 'error', handle, jid: tentativeJid, error: `Handle "${handle}" is already taken on AgentWire`, handleTaken: true };
    }
    agentwireAgentId = result.agentId;
  }

  const { jid, group } = manifestToRegisteredGroup(manifest, agentwireAgentId);

  // If updating, preserve added_at from existing record
  if (existing) {
    group.added_at = existing.added_at;
  }

  // Register in DB
  deps.registerGroup(jid, group);
  deps.setManifestHash(jid, hash);

  // Setup folder structure
  const manifestDir = path.dirname(manifestPath);
  setupGroupFolder(manifest, manifestDir);

  const action = existing ? 'updated' : 'created';
  logger.info({ handle, jid, action }, `Manifest applied (${action})`);
  return { status: action, handle, jid };
}
