import path from 'node:path';
import type { RunObserver, SuiteOptions } from '../types.js';
import { textReporter } from './text.js';
import { jsonlReporter } from './jsonl.js';
import { junitReporter } from './junit.js';
import { jsonReporter } from './json.js';

export function createReporters(opts: SuiteOptions): RunObserver[] {
  const stdout = opts.reporters.filter(({ name }) => name === 'text' || name === 'jsonl');
  if (stdout.length > 1) throw new Error('--reporter: at most one stdout reporter (text or jsonl) is allowed');
  const outputs = opts.reporters.flatMap(({ output }) => output?.trim() ? [path.resolve(output)] : []);
  const twice = outputs.find((file, n) => outputs.indexOf(file) !== n);
  if (twice) throw new Error(`--reporter: two reporters write ${twice}`);
  return opts.reporters.map(({ name, output }) => {
    if (name === 'text' || name === 'jsonl') {
      if (output !== undefined) throw new Error(`--reporter ${name}: output files are not supported`);
      return name === 'text' ? textReporter(opts.timing) : jsonlReporter();
    }
    if (name === 'junit' || name === 'json') {
      if (!output?.trim()) throw new Error(`--reporter ${name}: an output file is required`);
      return name === 'junit' ? junitReporter(output) : jsonReporter(output);
    }
    throw new Error(`--reporter ${name}: unknown reporter (expected text, jsonl, junit, or json)`);
  });
}
