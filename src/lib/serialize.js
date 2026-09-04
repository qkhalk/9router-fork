/**
 * Wrap an async function so concurrent callers queue on a promise chain
 * instead of overlapping (X4). Each caller still receives its own
 * result/error; a rejected call never poisons the chain for later callers.
 *
 * @template {any[]} A, R
 * @param {(...args: A) => Promise<R>} fn
 * @returns {(...args: A) => Promise<R>}
 */
export function createSerialized(fn) {
  let chain = Promise.resolve();
  return (...args) => {
    const run = chain.then(
      () => fn(...args),
      () => fn(...args)
    );
    // Keep the chain alive regardless of any individual caller's failure.
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}
