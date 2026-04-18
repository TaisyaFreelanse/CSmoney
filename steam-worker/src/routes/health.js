import { Router } from "express";

/**
 * @param {import("../accounts/AccountPool.js").AccountPool} pool
 * @param {import("../services/TaskQueue.js").TaskQueue} taskQueue
 */
export function healthRouter(pool, taskQueue) {
  const r = Router();
  r.get("/health", (_req, res) => {
    const acc = pool.getStats();
    const q = taskQueue.getStats();
    res.json({
      ok: true,
      service: "steam-worker",
      accounts: {
        total: acc.total,
        active: acc.busy,
        invalid: acc.invalid,
      },
      queue: {
        pending: q.pending,
        running: q.running,
      },
    });
  });
  return r;
}
