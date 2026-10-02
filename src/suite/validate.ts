import type { SuiteEngine } from './types.js';

export interface ValidationResult { file: string; error?: string; warnings: string[] }

/** Inspect every field the runners interpolate (browser `url`; desktop `app`; mobile target fields; steps) without
 *  resolving hook data or running code. `name` and `goal` are never interpolated. */
function checkPlaceholders(spec: unknown): void {
  if (spec === null || typeof spec !== 'object') return;
  const { url, steps, env, app, platform, device, capabilities } = spec as Record<string, unknown>;
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
        const expr = match[1];
        const [namespace, ...keys] = expr.split('.');
        if (namespace === 'hooks') continue; // known only after setup runs
        if (namespace !== 'env') throw new Error(`\${${expr}} uses an unknown namespace (use \${env.*} or \${hooks.*})`);
        let leaf: unknown = env;
        for (const key of keys) {
          if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf) || !Object.hasOwn(leaf, key)) {
            leaf = undefined;
            break;
          }
          leaf = (leaf as Record<string, unknown>)[key];
        }
        if (leaf === undefined || leaf === null || typeof leaf === 'object')
          throw new Error(`\${${expr}} is not defined (use \${env.*} from the spec's env block)`);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    // A step's `at` is the loader's source path (pick cache), never interpolated.
    else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { if (!(k === 'at' && 'kind' in value)) visit(v); });
  };
  for (const field of [url, app, platform, device, capabilities, steps]) visit(field);
}

export function validate<S>(engine: SuiteEngine<S>, files: string[]): ValidationResult[] {
  return files.map((file) => {
    const warnings: string[] = [];
    try {
      const spec = engine.load(file, { onMissingEnv: (message) => warnings.push(message) });
      checkPlaceholders(spec);
      return { file, warnings };
    }
    catch (error) { return { file, error: error instanceof Error ? error.message : String(error), warnings }; }
  });
}

/** Shared presentation for the CLI wrappers; validate itself stays side-effect-free. */
export function formatValidation(results: ValidationResult[]): string {
  return results.flatMap(({ file, error, warnings }) => [
    error === undefined ? `✔ ${file}` : `✘ ${file}: ${error}`,
    ...warnings.map((warning) => `! ${file}: ${warning}`),
  ]).join('\n');
}
