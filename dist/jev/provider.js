import { homedir } from 'node:os';
import { join } from 'node:path';
const KEY_BY_PROVIDER = { typesafe: 'TYPESAFE_API_KEY', gateway: 'AI_GATEWAY_API_KEY' };
/** Pinned, not `jev-latest`: the decision thresholds and the phrasing advice were tuned against these versions. */
export const MODEL_BY_PROVIDER = {
    typesafe: 'jev-1.13.0',
    gateway: 'typesafe-ai/jev',
};
/** A key file outside any project: Codex starts plugin MCP servers without the shell environment. */
export const USER_ENV_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plainwright', '.env');
/** Loads `.env` from the cwd, then the user file. A variable already in the environment is never overridden. */
export function loadEnvFiles() {
    for (const file of ['.env', USER_ENV_FILE]) {
        try {
            process.loadEnvFile(file);
        }
        catch {
            // Both files are optional.
        }
    }
}
export function selectProvider(env = process.env) {
    const requested = env.JEV_PROVIDER;
    if (requested !== undefined) {
        if (requested !== 'typesafe' && requested !== 'gateway') {
            throw new Error(`JEV_PROVIDER must be "typesafe" or "gateway", got "${requested}".`);
        }
        if (!env[KEY_BY_PROVIDER[requested]]) {
            throw new Error(`JEV_PROVIDER=${requested} requires ${KEY_BY_PROVIDER[requested]} to be set.`);
        }
        return requested;
    }
    if (env.TYPESAFE_API_KEY)
        return 'typesafe';
    if (env.AI_GATEWAY_API_KEY)
        return 'gateway';
    throw new Error('Set TYPESAFE_API_KEY (TypeSafe direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway) in the environment, ' +
        `in ${USER_ENV_FILE}, or in a .env file in the current directory.`);
}
let selected;
/** The provider of this process, chosen on first use: importing this module never needs a key. */
export function provider() {
    return (selected ??= selectProvider());
}
