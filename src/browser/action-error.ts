import { stripVTControlCharacters } from 'node:util';
import { errorMessage } from '../core/results.js';

/** Call log lines that every attempt repeats and that never say why the action failed. */
const ROUTINE_LOG = /^(\d+ × )?(waiting for|waiting \d+ms|retrying|attempting|scrolling into view|done scrolling|element is visible, enabled and stable|locator resolved to|navigating to)/;

/**
 * A Playwright error without its call log, which repeats every retry (60 lines for one covered button): the first
 * line, plus the last log line that gives a reason, such as the element that intercepts pointer events.
 */
export function actionError(error: unknown): string {
  const [head, log] = stripVTControlCharacters(errorMessage(error)).split('\nCall log:\n');
  if (log === undefined) return head;
  const reason = log.split('\n').map((line) => line.trim().replace(/^- /, ''))
    .filter((line) => line && !ROUTINE_LOG.test(line)).at(-1);
  return reason ? `${head.trim()} ${reason.slice(0, 300)}` : head.trim();
}
