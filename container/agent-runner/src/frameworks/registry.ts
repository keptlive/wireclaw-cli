/**
 * Framework adapter registry.
 * Maps framework names from manifest YAML to adapter constructors.
 */
import type { FrameworkAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { OpenCodeAdapter } from './opencode.js';
import { HermesAdapter } from './hermes.js';

interface AdapterDeps {
  log: (msg: string) => void;
  writeOutput: (output: any) => void;
  shouldClose: () => boolean;
}

const FRAMEWORKS: Record<string, (deps: AdapterDeps) => FrameworkAdapter> = {
  'claude-code': (deps) => new ClaudeCodeAdapter(deps),
  'opencode': (deps) => new OpenCodeAdapter(deps),
  'hermes': (deps) => new HermesAdapter(deps),
};

export function getAdapter(framework: string, deps: AdapterDeps): FrameworkAdapter {
  const factory = FRAMEWORKS[framework];
  if (!factory) {
    deps.log(`Unknown framework "${framework}", falling back to claude-code`);
    return new ClaudeCodeAdapter(deps);
  }
  return factory(deps);
}
