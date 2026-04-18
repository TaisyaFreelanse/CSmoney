/**
 * Rejects after `ms` unless `fn()` settles first. Does not abort `fn` — pair with
 * resource cleanup inside `fn` (e.g. browser.close on deadline).
 */
export function runWithTimeout(fn, ms) {
  let t;
  const deadline = new Promise((_, reject) => {
    t = setTimeout(() => {
      const err = new Error("timeout");
      err.code = "TASK_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(fn), deadline]).finally(() => {
    clearTimeout(t);
  });
}
