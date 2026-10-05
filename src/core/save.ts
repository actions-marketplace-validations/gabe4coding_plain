import { entryKey, type LockEntry, type LockRef } from './lock.js';

/*
 * The pure parts of MCP `save` (src/browser/mcp.ts, src/native/mcp.ts). Each server decides for itself whether a
 * typed value is a secret; this names the env key, builds the spec `env` block, and keeps the lock entries of
 * the steps that were saved.
 */

/** `password` for the first secret, then `password2`, `password3`. `seen` is how many distinct secrets exist. */
export const secretKeyName = (seen: number): string => seen ? `password${seen + 1}` : 'password';

/** The spec `env` block: `password: $PASSWORD`, then `password2: $PASSWORD_2`. Empty when no secret was typed. */
export function secretEnv(keys: Iterable<string>) {
  const secrets = [...keys].map((key, i) => [key, i ? `$PASSWORD_${i + 1}` : '$PASSWORD']);
  return secrets.length ? { env: Object.fromEntries(secrets) } : {};
}

/** Entries of steps that were saved. A record at the transcript length or past it is left out. */
export function savedLockEntries(
  recorded: readonly { ref: LockRef; entry: LockEntry }[],
  transcriptLength: number,
): Map<string, LockEntry> {
  return new Map(recorded.filter(({ ref }) => ref.at.index < transcriptLength)
    .map(({ ref, entry }) => [entryKey(ref), entry] as const));
}
