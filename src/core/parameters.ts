import type { PlaceholderValues } from './interpolate.js';

/*
 * Placeholder-aware lock entries (src/core/lock.ts): the values a run filled in (`${env.*}`, `${hooks.*}`) are
 * written back as their placeholders in lock keys, locators and claim states. A run with other values (a title
 * a setup hook makes unique per run, another dataset row) then finds the same entry and fills its own values in.
 * No filled-in value lands in a lock file.
 */

/** `[placeholder, value]` pairs, the longest value first, so a value inside another one never splits it. */
export type RunValues = readonly (readonly [placeholder: string, value: string])[];

/**
 * A value this short is replaced only where no letter or digit touches it: the day `15` in "15 Nov", not in
 * "2015". A longer value is replaced wherever it occurs (a title inside a row's name).
 */
const SHORT = 4;

export function parametersOf(values: PlaceholderValues): RunValues {
  const pairs: [string, string][] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value);
      if (text) pairs.push([`\${${path}}`, text]);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
    }
  };
  walk(values.env, 'env');
  walk(values.hooks, 'hooks');
  return pairs.sort(([a, x], [b, y]) => y.length - x.length || (a < b ? -1 : a > b ? 1 : 0));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each value in `text` becomes its placeholder, in one pass: a placeholder put in is never matched again. */
export function parameterize(text: string, parameters: RunValues): string {
  if (!parameters.length) return text;
  const alternatives = parameters.map(([, value]) => value.length >= SHORT
    ? escapeRegExp(value) : `(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`);
  const placeholderOf = new Map<string, string>();
  for (const [placeholder, value] of parameters) if (!placeholderOf.has(value)) placeholderOf.set(value, placeholder);
  return text.replace(new RegExp(alternatives.join('|'), 'gu'), (value) => placeholderOf.get(value)!);
}

/** Each placeholder of this run in `text` becomes its value; any other `${…}` stays as it is (page text). */
export function fill(text: string, parameters: RunValues): string {
  if (!text.includes('${')) return text;
  const valueOf = new Map(parameters);
  return text.replace(/\$\{(?:env|hooks)\.[^}]+\}/g, (placeholder) => valueOf.get(placeholder) ?? placeholder);
}

/** A copy of `value` with `map` applied to every string, except under the keys in `keep` (names, not data). */
export function mapStrings<T>(value: T, map: (text: string) => string, keep: ReadonlySet<string>): T {
  if (typeof value === 'string') return map(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map, keep)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, keep.has(key) ? item : mapStrings(item, map, keep)])) as T;
}
