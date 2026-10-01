import type { BrowserContextOptions } from 'playwright';
import type { Spec } from './spec.js';
import type { RunOptions } from './runner.js';

export function browserContextOptions(spec: Spec, _opts: RunOptions): BrowserContextOptions {
  if (spec.browser && Object.keys(spec.browser).length) throw new Error('browser: not implemented yet');
  const options: BrowserContextOptions = {};
  if (spec.auth) options.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
  if (spec.geolocation) {
    options.geolocation = { latitude: spec.geolocation.lat, longitude: spec.geolocation.lon };
    options.permissions = ['geolocation'];
  }
  return options;
}
