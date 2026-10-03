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
/** A child frame inherits inertness from its embedding element, including shadow hosts and outer frames. */
export async function frameIsInert(frame) {
    for (let parent = frame.parentFrame(); parent; frame = parent, parent = frame.parentFrame()) {
        const element = await frame.frameElement();
        try {
            const inert = await element.evaluate((node) => {
                if (!(node instanceof Element))
                    return false;
                for (let el = node; el;) {
                    if (el.hasAttribute('inert'))
                        return true;
                    if (el.matches('dialog:modal'))
                        return false;
                    const root = el.getRootNode();
                    el = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
                }
                return false;
            });
            if (inert)
                return true;
        }
        finally {
            await element.dispose();
        }
    }
    return false;
}
