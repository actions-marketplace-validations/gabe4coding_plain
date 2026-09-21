export function serialQueue() {
    let tail = Promise.resolve();
    return (fn) => {
        const result = tail.then(fn);
        tail = result.catch(() => { });
        return result;
    };
}
