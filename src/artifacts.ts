import type { RunObserver, SuiteOptions } from './suite-types.js';

export function artifactsObserver(opts: SuiteOptions): RunObserver | null {
  if (opts.artifacts) throw new Error('--artifacts: not implemented yet');
  return null;
}

export function checkArtifactModes(screenshot: string | undefined, trace: string | undefined, dir: string | undefined): void {
  if (screenshot && screenshot !== 'on-failure') throw new Error('--screenshot: not implemented yet');
  if (trace && trace !== 'on-failure') throw new Error('--trace: not implemented yet');
  if (dir) throw new Error('--artifacts: not implemented yet');
}
