export function validate(engine, files) {
    return files.map((file) => {
        const warnings = [];
        try {
            engine.load(file, { onMissingEnv: (message) => warnings.push(message) });
            return { file, warnings };
        }
        catch (error) {
            return { file, error: error instanceof Error ? error.message : String(error), warnings };
        }
    });
}
