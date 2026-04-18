let warnedNoKey = false;

/**
 * If `API_KEY` is set, require `x-api-key` header to match. Otherwise allow (dev) with one warning.
 */
export function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY?.trim();
  if (!expected) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn("[steam-worker] API_KEY is not set — /inventory and /debug/accounts are open");
    }
    return next();
  }
  const got = req.headers["x-api-key"];
  if (typeof got !== "string" || got !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
