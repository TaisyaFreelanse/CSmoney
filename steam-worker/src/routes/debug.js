import { Router } from "express";

/**
 * @param {import("../accounts/AccountPool.js").AccountPool} pool
 */
export function debugRouter(pool) {
  const r = Router();
  r.get("/debug/accounts", (_req, res) => {
    res.json(pool.getDebugAccounts());
  });
  return r;
}
