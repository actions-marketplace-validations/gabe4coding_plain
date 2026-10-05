import { closeSync, fchmodSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { entryKey, formatLock, lockPath, type LockEntry, type LockRef } from './lock.js';

/*
 * What MCP `save` shares between the browser server (src/browser/mcp.ts) and the desktop/mobile one
 * (src/native/mcp.ts): secret values written as `${env.*}` placeholders, and the spec and lock files. Each server
 * decides for itself whether a typed value went into a secret field.
 */

/** `password` for the first secret, then `password2`, `password3`. */
const keyName = (i: number): string => i ? `password${i + 1}` : 'password';
/** The variable a saved spec reads the secret from: `$PASSWORD`, then `$PASSWORD_2`, `$PASSWORD_3`. */
const variableName = (i: number): string => i ? `$PASSWORD_${i + 1}` : '$PASSWORD';

/**
 * Each value typed into a secret field during one recording, with the `env` key `save` writes in its place. A key
 * and its variable both follow from the order the values were first typed, so they always match.
 */
export class SecretNames {
  private readonly keys = new Map<string, string>();

  /**
   * The fill step as `save` writes it. A value typed into a secret field, or typed into one before (a confirm field
   * that is not secret), becomes an `${env.*}` placeholder. `isSecret` is asked only for a value not seen yet. An
   * empty value and a value with a placeholder stay as written.
   */
  async savedFill(step: Record<string, unknown>, value: string | undefined,
    isSecret: () => boolean | Promise<boolean>): Promise<Record<string, unknown>> {
    if (!value || value.includes('${')) return step;
    let key = this.keys.get(value);
    if (!key) {
      if (!(await isSecret())) return step;
      key = keyName(this.keys.size);
      this.keys.set(value, key);
    }
    return { ...step, fill: { ...(step.fill as Record<string, unknown>), value: `\${env.${key}}` } };
  }

  /** The spec `env` block: `password: $PASSWORD`, then `password2: $PASSWORD_2`. Empty when no secret was typed. */
  env(): { env?: Record<string, string> } {
    const count = this.keys.size;
    return count ? { env: Object.fromEntries(Array.from({ length: count }, (_, i) => [keyName(i), variableName(i)] as const)) } : {};
  }
}

/**
 * Writes the saved spec, then its lock: the entries of the saved steps (a record at the transcript length or past
 * it is left out). With no entry, an old lock next to the spec is removed. Refuses a spec with no step, before it
 * writes anything. Returns `{ lock }` when a lock was written.
 */
export function writeSaved(
  file: string,
  doc: Record<string, unknown> & { steps: readonly unknown[] },
  recorded: readonly { ref: LockRef; entry: LockEntry }[],
  mode?: number,
): { lock?: string } {
  if (!doc.steps.length) throw new Error('No successful steps to save');
  write(file, stringify(doc), mode);
  const entries = new Map(recorded.filter(({ ref }) => ref.at.index < doc.steps.length)
    .map(({ ref, entry }) => [entryKey(ref), entry] as const));
  const lockFile = lockPath(file);
  if (!entries.size) {
    rmSync(lockFile, { force: true });
    return {};
  }
  write(lockFile, formatLock(entries), mode);
  return { lock: lockFile };
}

/** writeFileSync applies `mode` only to a file it creates: an existing file is narrowed before it gets the text. */
function write(file: string, text: string, mode: number | undefined): void {
  if (mode === undefined) {
    writeFileSync(file, text);
    return;
  }
  const fd = openSync(file, 'w', mode);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
