import type { SuiteEngine } from './suite-types.js';

// Same messages as runSpec, runNativeSpec, and browserContextOptions. A spec with these fields cannot run in Phase 0.
function unimplemented(spec: unknown): string | undefined {
  if (spec === null || typeof spec !== 'object') return;
  const { timeout, browser } = spec as { timeout?: unknown; browser?: object };
  const errors = [
    ...(timeout !== undefined ? ['timeout: not implemented yet'] : []),
    ...(browser && Object.keys(browser).length ? ['browser: not implemented yet'] : []),
  ];
  return errors.length ? errors.join('; ') : undefined;
}

export function validate<S>(engine: SuiteEngine<S>, files: string[]): { file: string; error?: string; warnings: string[] }[] {
  return files.map((file) => {
    const warnings: string[] = [];
    try {
      const error = unimplemented(engine.load(file, { onMissingEnv: (message) => warnings.push(message) }));
      return error === undefined ? { file, warnings } : { file, error, warnings };
    } catch (error) { return { file, error: error instanceof Error ? error.message : String(error), warnings }; }
  });
}
