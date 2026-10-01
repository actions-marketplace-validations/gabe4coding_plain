import type { SuiteEngine } from './suite-types.js';

export interface ValidationResult { file: string; error?: string; warnings: string[] }

/** Inspect the loader's normalized URL and steps without resolving hook data or running code. */
function checkPlaceholders(spec: unknown): void {
  if (spec === null || typeof spec !== 'object') return;
  const { url, steps, env } = spec as { url?: unknown; steps?: unknown; env?: unknown };
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
        const expr = match[1];
        const [namespace, ...keys] = expr.split('.');
        if (namespace !== 'env') continue;
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
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(url);
  visit(steps);
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
