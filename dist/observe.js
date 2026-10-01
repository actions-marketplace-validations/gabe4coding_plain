export function observerCalls(observer, info) {
    let warned = false;
    const call = async (name, event) => {
        const fn = observer?.[name];
        if (!fn)
            return undefined;
        try {
            return await fn({ ...info, ...event });
        }
        catch (error) {
            if (!warned) {
                warned = true;
                console.error(`plainwright: observer: ${error instanceof Error ? error.message : String(error)}`);
            }
            return undefined;
        }
    };
    return call;
}
