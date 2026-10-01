// Lane E's guards, checked when a spec loads (so `validate` reports them too) and when the CLI starts.
export function checkSpecFeatures(spec: { timeout?: number; browser?: object }, file: string): void {
  if (spec.timeout !== undefined) throw new Error(`invalid spec: ${file}: timeout: not implemented yet`);
  if (spec.browser && Object.keys(spec.browser).length) throw new Error(`invalid spec: ${file}: browser: not implemented yet`);
}

export function checkSpecTimeoutFlag(value?: number): void {
  if (value !== undefined) throw new Error('--spec-timeout: not implemented yet');
}
