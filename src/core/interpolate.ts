export interface PlaceholderValues { env: Record<string, unknown>; hooks: Record<string, unknown> }

/**
 * Replaces every `${env.a.b}` / `${hooks.a.b}` in the strings of `value` with the leaf it names: the spec's env
 * block, or what the hooks module's setup returned. Returns a new value; an unknown or missing leaf throws.
 */
export function interpolate<T>(value: T, values: PlaceholderValues, where: string): T {
  if (typeof value === 'string') return interpolateString(value, values, where) as T;
  if (Array.isArray(value)) return value.map((item) => interpolate(item, values, where)) as T;
  if (value === null || typeof value !== 'object') return value;
  if ('kind' in value && 'at' in value) {
    // A parsed step's `at` is its source path, not spec text: a `${` in a folder name stays as it is.
    const { at, ...rest } = value as Record<string, unknown>;
    return { ...interpolate(rest, values, where), at } as T;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, values, where)])) as T;
}

function interpolateString(text: string, values: PlaceholderValues, where: string): string {
  if (!text.includes('${')) return text;
  return text.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
    const leaf = lookup(expression, values);
    if (leaf === undefined || leaf === null || typeof leaf === 'object') {
      throw new Error(`invalid spec: ${where}: \${${expression}} is not defined ` +
        "(use ${env.*} from the spec's env block or ${hooks.*} from what setup returned)");
    }
    return String(leaf);
  });
}

function lookup(expression: string, values: PlaceholderValues): unknown {
  const [namespace, ...path] = expression.split('.');
  let leaf: unknown = namespace === 'env' || namespace === 'hooks' ? values[namespace] : undefined;
  for (const key of path) {
    if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) return undefined;
    leaf = (leaf as Record<string, unknown>)[key];
  }
  return leaf;
}
