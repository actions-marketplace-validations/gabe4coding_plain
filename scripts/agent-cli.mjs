// What the agent evals (scripts/eval-agent.mjs, scripts/eval-routing.mjs) share to run `claude -p` and `codex exec`.
import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Runs an agent CLI, parses its JSON lines with `parse`; the process's own failure becomes `failed`. */
export function collect(command, args, { cwd, env = process.env, stdin = 'ignore' }, parse) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: [stdin, 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => done({ ...parse([]), failed: `${command}: ${error.message}` }));
    child.on('close', (code) => {
      const events = out.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const parsed = { ...parse(events), transcript: out };
      if (!parsed.failed && code !== 0) parsed.failed = `${command} exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`;
      done({ ms: Date.now() - started, ...parsed });
    });
  });
}

/**
 * A Codex home in `dir` that holds only the user's Codex login and `config` (TOML lines): no user config, plugins,
 * apps, AGENTS.md, hooks or memories. Codex still reads the user's skills in ~/.agents/skills.
 */
export function codexHome(dir, config = []) {
  const home = join(dir, 'codex-home');
  const userHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  mkdirSync(home);
  symlinkSync(join(userHome, 'auth.json'), join(home, 'auth.json'));
  writeFileSync(join(home, 'config.toml'), [
    // The account's apps and remote plugins add hundreds of tools.
    '[features]',
    'apps = false',
    'plugins = false',
    'remote_plugin = false',
    ...config,
  ].join('\n') + '\n', { mode: 0o600 });
  return home;
}
