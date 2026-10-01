export function expandIncludes(rawSteps: unknown[], _file: string): unknown[] {
  for (const step of rawSteps) {
    if (step !== null && typeof step === 'object' && 'include' in step) throw new Error('include: not implemented yet');
    if (step !== null && typeof step === 'object' && 'origin' in step) throw new Error('origin: reserved for included steps');
  }
  return rawSteps;
}
