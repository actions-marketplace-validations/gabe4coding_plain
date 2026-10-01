import fs from 'node:fs';
import path from 'node:path';
export function loadConfig(cwd, explicit) {
    const file = explicit ? path.resolve(cwd, explicit) : path.join(cwd, 'plainwright.config.yaml');
    if (!fs.existsSync(file)) {
        if (explicit)
            throw new Error(`--config: file not found: ${file}`);
        return {};
    }
    throw new Error('--config: not implemented yet');
}
