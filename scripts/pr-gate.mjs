#!/usr/bin/env node
// PreToolUse hook (Claude Code .claude/settings.json, Codex .codex/hooks.json): blocks `gh pr create` unless
// scripts/validate.mjs passed on exactly the files of HEAD. Every other command passes through untouched.
// Exit 2 with a reason on stderr is the block signal both agents understand.
import { headTree, readStamp } from './validation-stamp.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let command = '';
try { command = JSON.parse(input).tool_input?.command ?? ''; } catch { process.exit(0); }
if (!/\bgh\s+pr\s+create\b/.test(command)) process.exit(0);

const stamp = readStamp();
const tree = headTree();
if (stamp?.tree === tree) process.exit(0);
console.error(stamp
  ? `Blocked: HEAD's files changed since the last passing validation (${stamp.at}). Run the validating-changes skill ` +
    '(node scripts/validate.mjs) on the committed files, then open the pull request.'
  : 'Blocked: no passing validation for this worktree. Run the validating-changes skill (node scripts/validate.mjs) ' +
    'before you open a pull request.');
process.exit(2);
