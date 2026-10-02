// Schema validation handles the fields; keep these seams for the frozen loaders and CLIs.
export function checkSpecFeatures(spec, file) {
    if (spec.timeout !== undefined && (!Number.isSafeInteger(spec.timeout) || spec.timeout <= 0))
        throw new Error(`invalid spec: ${file}: timeout must be a positive safe integer`);
}
export function checkSpecTimeoutFlag(value) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error('--spec-timeout must be a positive safe integer');
}
