export function artifactsObserver(opts) {
    if (opts.artifacts)
        throw new Error('--artifacts: not implemented yet');
    return null;
}
export function checkArtifactModes(screenshot, trace, dir) {
    if (screenshot && screenshot !== 'on-failure')
        throw new Error('--screenshot: not implemented yet');
    if (trace && trace !== 'on-failure')
        throw new Error('--trace: not implemented yet');
    if (dir)
        throw new Error('--artifacts: not implemented yet');
}
