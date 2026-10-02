// Schema validation handles the fields; keep these seams for the frozen loaders and CLIs.
export function checkSpecFeatures(spec: { timeout?: number; browser?: object }, file: string): void {
  if (spec.timeout !== undefined && (!Number.isSafeInteger(spec.timeout) || spec.timeout <= 0))
    throw new Error(`invalid spec: ${file}: timeout must be a positive safe integer`);
}

export function checkSpecTimeoutFlag(value?: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw new Error('--spec-timeout must be a positive safe integer');
}
