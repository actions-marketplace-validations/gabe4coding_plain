import type { Loaded, SuiteOptions } from './suite-types.js';

export function select<S>(specs: Loaded<S>[], opts: SuiteOptions): Loaded<S>[] {
  if (opts.grep !== undefined) throw new Error('--grep: not implemented yet');
  if (opts.grepInvert !== undefined) throw new Error('--grep-invert: not implemented yet');
  if (opts.tags.length) throw new Error('--tag: not implemented yet');
  return specs;
}

export function listSelected<S>(specs: Loaded<S>[], opts: SuiteOptions): boolean {
  if (opts.list) throw new Error('--list: not implemented yet');
  return false;
}
