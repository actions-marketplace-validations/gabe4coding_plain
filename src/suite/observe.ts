import { errorMessage } from '../core/results.js';
import type { RunObserver, SpecInfo } from './types.js';

export function observerCalls(observer: RunObserver | undefined, info: SpecInfo) {
  let warned = false;
  const call = async <T>(name: 'sessionOpen' | 'stepEnd' | 'sessionClose', event: object): Promise<T | undefined> => {
    const fn = observer?.[name] as ((event: object) => Promise<T>) | undefined;
    if (!fn) return undefined;
    try { return await fn({ ...info, ...event }); }
    catch (error) {
      if (!warned) {
        warned = true;
        console.error(`plain: observer: ${errorMessage(error)}`);
      }
      return undefined;
    }
  };
  return call;
}
