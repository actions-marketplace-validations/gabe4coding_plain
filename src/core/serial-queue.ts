/** Runs the functions it is given one at a time, in call order; a failure does not stop the next one. */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}
