import express from "express";
import { AccountPool } from "./accounts/AccountPool.js";
import { TaskQueue } from "./services/TaskQueue.js";
import { InventoryCache } from "./services/inventoryCache.js";
import { createInventoryHandler } from "./services/inventoryService.js";
import { healthRouter } from "./routes/health.js";
import { inventoryRouter } from "./routes/inventory.js";
import { debugRouter } from "./routes/debug.js";
import { requireApiKey } from "./middleware/apiKey.js";

export function createApp() {
  const app = express();

  if (process.env.TRUST_PROXY === "1") {
    app.set("trust proxy", 1);
  }

  const maxGlobal = Math.max(1, Math.min(10, Number(process.env.STEAM_WORKER_MAX_CONCURRENT) || 4));
  const maxQueue = Math.max(1, Math.min(500, Number(process.env.QUEUE_MAX_SIZE) || 50));
  const cacheTtl = Math.max(1000, Number(process.env.CACHE_TTL_MS) || 120_000);

  const pool = new AccountPool();
  const taskQueue = new TaskQueue(maxGlobal, maxQueue);
  const cache = new InventoryCache(cacheTtl);
  const handleInventory = createInventoryHandler(pool, taskQueue, cache);

  app.use(healthRouter(pool, taskQueue));

  const protectedApi = express.Router();
  protectedApi.use(requireApiKey);
  protectedApi.use(inventoryRouter(handleInventory));
  protectedApi.use(debugRouter(pool));
  app.use(protectedApi);

  return app;
}
