#!/usr/bin/env tsx
/**
 * CLI for applying WireClaw YAML group manifests.
 *
 * Usage:
 *   npx tsx src/manifest-cli.ts apply groups/eng-triage/wireclaw.yaml
 *   npx tsx src/manifest-cli.ts apply manifests/           # apply all in directory
 *   npx tsx src/manifest-cli.ts apply                      # discover and apply all
 */
import fs from 'fs';
import path from 'path';

import {
  getManifestHash,
  getRegisteredGroup,
  initDatabase,
  setManifestHash,
  setRegisteredGroup,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  applyManifest,
  ApplyResult,
  discoverManifests,
  loadManifest,
} from './manifest.js';
import { RegisteredGroup } from './types.js';

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch {
    logger.warn({ jid, folder: group.folder }, 'Invalid folder in manifest');
    return;
  }
  setRegisteredGroup(jid, group);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
}

async function applyFile(filePath: string): Promise<ApplyResult> {
  return applyManifest(filePath, {
    registerGroup,
    getManifestHash,
    setManifestHash,
    getRegisteredGroup,
  });
}

async function applyAll(targets: string[]): Promise<void> {
  const results: ApplyResult[] = [];

  for (const target of targets) {
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat) {
      console.error(`Not found: ${target}`);
      continue;
    }

    if (stat.isDirectory()) {
      // Apply all .yaml files in the directory
      const files = fs.readdirSync(target)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => path.join(target, f));

      if (files.length === 0) {
        // Maybe it's a group dir with wireclaw.yaml inside
        const nested = path.join(target, 'wireclaw.yaml');
        if (fs.existsSync(nested)) {
          files.push(nested);
        }
      }

      for (const file of files) {
        results.push(await applyFile(file));
      }
    } else {
      results.push(await applyFile(target));
    }
  }

  // Print summary
  console.log('\nResults:');
  for (const r of results) {
    const icon = r.status === 'created' ? '+' :
                 r.status === 'updated' ? '~' :
                 r.status === 'unchanged' ? '=' : '!';
    const msg = r.error ? ` (${r.error})` : '';
    console.log(`  [${icon}] ${r.handle} → ${r.jid} (${r.status})${msg}`);
    if (r.handleTaken) {
      console.log(`      Handle "${r.handle}" is taken. Edit the YAML and choose a different handle.`);
    }
  }

  const created = results.filter(r => r.status === 'created').length;
  const updated = results.filter(r => r.status === 'updated').length;
  const unchanged = results.filter(r => r.status === 'unchanged').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log(`\n${created} created, ${updated} updated, ${unchanged} unchanged, ${errors} errors`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'apply') {
    console.log('Usage: npx tsx src/manifest-cli.ts apply [file-or-dir...]');
    console.log('');
    console.log('  apply                    Discover and apply all manifests');
    console.log('  apply <file.yaml>        Apply a single manifest');
    console.log('  apply <dir/>             Apply all manifests in directory');
    process.exit(1);
  }

  initDatabase();

  const targets = args.slice(1);
  if (targets.length === 0) {
    // Auto-discover
    const discovered = discoverManifests();
    if (discovered.length === 0) {
      console.log('No manifests found. Place wireclaw.yaml in groups/{handle}/ or manifests/');
      return;
    }
    console.log(`Discovered ${discovered.length} manifest(s):`);
    for (const f of discovered) {
      console.log(`  ${f}`);
    }
    await applyAll(discovered);
  } else {
    await applyAll(targets);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
