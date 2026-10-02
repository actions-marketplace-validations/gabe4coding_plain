/**
 * Replaces every `${env.a.b}` / `${hooks.a.b}` in the strings of `value` with the leaf it names: the spec's env
 * block, or what the hooks module's setup returned. Returns a new value; an unknown or missing leaf throws.
 */
export function interpolate(value, values, where) {
    if (typeof value === 'string')
        return interpolateString(value, values, where);
    if (Array.isArray(value))
        return value.map((item) => interpolate(item, values, where));
    if (value === null || typeof value !== 'object')
        return value;
    if ('kind' in value && 'at' in value) {
        // A parsed step's `at` is its source path, not spec text: a `${` in a folder name stays as it is.
        const { at, ...rest } = value;
        return { ...interpolate(rest, values, where), at };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, values, where)]));
}
function interpolateString(text, values, where) {
    if (!text.includes('${'))
        return text;
    return text.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
        const leaf = lookup(expression, values);
        if (leaf === undefined || leaf === null || typeof leaf === 'object') {
            throw new Error(`invalid spec: ${where}: \${${expression}} is not defined ` +
                "(use ${env.*} from the spec's env block or ${hooks.*} from what setup returned)");
        }
        return String(leaf);
    });
}
function lookup(expression, values) {
    const [namespace, ...path] = expression.split('.');
    let leaf = namespace === 'env' || namespace === 'hooks' ? values[namespace] : undefined;
    for (const key of path) {
        if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf))
            return undefined;
        leaf = leaf[key];
    }
    return leaf;
}
