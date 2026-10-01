import fs from 'node:fs';
import path from 'node:path';
import type { EngineFlags, SuiteOptions } from './suite-types.js';

export function loadConfig(cwd: string, explicit?: string): Partial<SuiteOptions & EngineFlags> {
  const file = explicit ? path.resolve(cwd, explicit) : path.join(cwd, 'plainwright.config.yaml');
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`--config: file not found: ${file}`);
    return {};
  }
  throw new Error('--config: not implemented yet');
}
