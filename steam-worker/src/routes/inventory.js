import { Router } from "express";
import rateLimit from "express-rate-limit";
import { buildInventoryMetaV1 } from "../utils/inventoryResponseMeta.js";

/**
 * @param {ReturnType<import("../services/inventoryService.js").createInventoryHandler>} handleInventory
 */
export function inventoryRouter(handleInventory) {
  const r = Router();

  const windowMs = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000);
  const max = Math.max(1, Number(process.env.RATE_LIMIT_MAX) || 20);

  const inventoryLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "rate_limit_exceeded" },
  });

  r.get("/inventory", inventoryLimiter, async (req, res) => {
    try {
      const { steamId, tradeUrl } = req.query;
      const result = await handleInventory({
        steamId: typeof steamId === "string" ? steamId : undefined,
        tradeUrl: typeof tradeUrl === "string" ? tradeUrl : undefined,
      });
      res.status(result.status).json(result.body);
    } catch (e) {
      res.status(500).json({
        items: [],
        source: null,
        accountId: null,
        durationMs: 0,
        error: e?.message || "internal_error",
        meta: buildInventoryMetaV1({
          apiMeta: { attempted: false, error: "internal_error" },
          tradeOutcome: null,
        }),
      });
    }
  });
  return r;
}
