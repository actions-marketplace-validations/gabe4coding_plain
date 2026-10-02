/** Inspect every field the runners interpolate (browser `url`; desktop `app`; mobile target fields; steps) without
 *  resolving hook data or running code. `name` and `goal` are never interpolated. */
function checkPlaceholders(spec) {
    if (spec === null || typeof spec !== 'object')
        return;
    const { url, steps, env, app, platform, device, capabilities } = spec;
    const visit = (value) => {
        if (typeof value === 'string') {
            for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
                const expr = match[1];
                const [namespace, ...keys] = expr.split('.');
                if (namespace === 'hooks')
                    continue; // known only after setup runs
                if (namespace !== 'env')
                    throw new Error(`\${${expr}} uses an unknown namespace (use \${env.*} or \${hooks.*})`);
                let leaf = env;
                for (const key of keys) {
                    if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf) || !Object.hasOwn(leaf, key)) {
                        leaf = undefined;
                        break;
                    }
                    leaf = leaf[key];
                }
                if (leaf === undefined || leaf === null || typeof leaf === 'object')
                    throw new Error(`\${${expr}} is not defined (use \${env.*} from the spec's env block)`);
            }
        }
        else if (Array.isArray(value))
            value.forEach(visit);
        else if (value !== null && typeof value === 'object')
            Object.values(value).forEach(visit);
    };
    for (const field of [url, app, platform, device, capabilities, steps])
        visit(field);
}
export function validate(engine, files) {
    return files.map((file) => {
        const warnings = [];
        try {
            const spec = engine.load(file, { onMissingEnv: (message) => warnings.push(message) });
            checkPlaceholders(spec);
            return { file, warnings };
        }
        catch (error) {
            return { file, error: error instanceof Error ? error.message : String(error), warnings };
        }
    });
}
/** Shared presentation for the CLI wrappers; validate itself stays side-effect-free. */
export function formatValidation(results) {
    return results.flatMap(({ file, error, warnings }) => [
        error === undefined ? `✔ ${file}` : `✘ ${file}: ${error}`,
        ...warnings.map((warning) => `! ${file}: ${warning}`),
    ]).join('\n');
}
