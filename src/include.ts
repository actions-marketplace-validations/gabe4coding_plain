import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parse } from 'yaml';

/** Expand raw YAML before validation; only this loader may produce step origins. */
export function expandIncludes(rawSteps: unknown[], file: string): unknown[] {
  const root = resolve(file);
  const folder = dirname(root);
  const display = (file: string) => relative(folder, file);
  // Real paths also catch cycles through symlinks. The root may be virtual in unit tests.
  const identity = (file: string) => { try { return realpathSync(file); } catch { return file; } };
  function expand(steps: unknown[], source: string, chain: string[]): unknown[] {
    return steps.flatMap((step): unknown[] => {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) return [step];
      const mapping = step as Record<string, unknown>;
      if ('origin' in mapping) throw new Error(`invalid spec: ${display(source)}: origin: reserved for included steps`);
      if (!('include' in mapping)) return [source === root ? step : { ...mapping, origin: display(source) }];
      if (mapping.optional === true) throw new Error(`invalid spec: ${display(source)}: optional: true on include is not supported in v1`);
      for (const key of Object.keys(mapping)) {
        if (key !== 'include' && key !== 'optional') throw new Error(`invalid spec: ${display(source)}: include has unexpected key "${key}"`);
      }
      if (typeof mapping.include !== 'string' || !mapping.include.trim())
        throw new Error(`invalid spec: ${display(source)}: include must be a non-empty path`);
      const included = resolve(dirname(source), mapping.include);
      if (chain.some((file) => identity(file) === identity(included)))
        throw new Error(`invalid spec: include cycle: ${[...chain, included].map(display).join(' → ')}`);
      let raw: unknown;
      try { raw = parse(readFileSync(included, 'utf8')); }
      catch (error) { throw new Error(`invalid spec: ${display(included)}: ${error instanceof Error ? error.message : String(error)}`); }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(`invalid spec: ${display(included)}: included file must contain only steps:`);
      const flow = raw as Record<string, unknown>;
      for (const key of Object.keys(flow)) {
        if (key !== 'steps') throw new Error(`invalid spec: ${display(included)}: included file has unexpected key "${key}" (only steps: is allowed)`);
      }
      if (!Array.isArray(flow.steps)) throw new Error(`invalid spec: ${display(included)}: steps must be an array`);
      return expand(flow.steps, included, [...chain, included]);
    });
  }
  return expand(rawSteps, root, [root]);
}
