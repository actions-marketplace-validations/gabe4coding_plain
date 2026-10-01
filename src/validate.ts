import type { SuiteEngine } from './suite-types.js';

export function validate<S>(engine: SuiteEngine<S>, files: string[]): { file: string; error?: string; warnings: string[] }[] {
  return files.map((file) => {
    const warnings: string[] = [];
    try { engine.load(file, { onMissingEnv: (message) => warnings.push(message) }); return { file, warnings }; }
    catch (error) { return { file, error: error instanceof Error ? error.message : String(error), warnings }; }
  });
}
