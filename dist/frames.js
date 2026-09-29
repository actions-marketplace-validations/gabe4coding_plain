/** Iframe name, or its URL's pathname. Labels iframe candidates and iframe snapshot sections. */
export function frameLabel(frame) {
    const name = frame.name();
    if (name)
        return name;
    try {
        return new URL(frame.url()).pathname || frame.url();
    }
    catch {
        return frame.url();
    }
}
