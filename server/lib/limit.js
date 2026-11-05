// Minimal concurrency limiter: limit(fn) runs at most `max` fns at once.
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// Deduplicates concurrent calls with the same key: callers share one in-flight promise.
export function createOnce() {
  const inflight = new Map();
  return (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve()
      .then(fn)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
