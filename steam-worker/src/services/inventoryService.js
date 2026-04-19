import { fetchTradeInventory } from "../puppeteer/fetchTradeInventory.js";
import { parseTradeUrl, tradeUrlFromParsed, steamId64FromPartner, normalizeSteamId64 } from "../utils/steamUrl.js";
import { logJson, logInventoryEvent } from "../utils/logger.js";
import { InventoryCache } from "./inventoryCache.js";

const TASK_TIMEOUT_MS = Math.min(
  180_000,
  Math.max(90_000, Number(process.env.STEAM_WORKER_TASK_TIMEOUT_MS) || 120_000),
);

/**
 * @param {import("../accounts/AccountPool.js").AccountPool} pool
 * @param {import("../services/TaskQueue.js").TaskQueue} taskQueue
 * @param {import("../services/inventoryCache.js").InventoryCache} cache
 */
export function createInventoryHandler(pool, taskQueue, cache) {
  async function executeWithAccount(account, canonical, partnerSteamId64) {
    pool.ensureProfileDir(account);
    const t0 = Date.now();
    const r = await fetchTradeInventory({
      tradeUrlCanonical: canonical,
      partnerSteamId64,
      userDataDir: account.userDataDir,
      accountId: account.id,
      taskTimeoutMs: TASK_TIMEOUT_MS,
      partnerXhrWaitMs: Math.min(
        90_000,
        Math.max(30_000, Number(process.env.STEAM_WORKER_PARTNER_XHR_WAIT_MS) || 60_000),
      ),
    });
    const durationMs = Date.now() - t0;
    logJson("steam_worker_request_done", {
      accountId: account.id,
      durationMs,
      itemsCount: r.items?.length ?? 0,
      error: r.ok ? null : (r.error ?? r.detail ?? "unknown"),
      timestamp: Date.now(),
      ok: r.ok,
      sessionInvalid: r.sessionInvalid ?? false,
      timedOut: r.timedOut ?? false,
    });
    if (r.sessionInvalid) {
      pool.markSessionInvalid(account.id, r.detail || "session");
    }
    return { ...r, durationMs, accountId: account.id };
  }

  return async function handleInventory(query) {
    const tradeUrl = query.tradeUrl?.trim();
    const steamIdCheck = query.steamId?.trim();

    if (!tradeUrl) {
      return {
        ok: false,
        status: 400,
        body: {
          items: [],
          source: null,
          accountId: null,
          durationMs: 0,
          error: "tradeUrl is required (steamId alone is not enough for trade-offer inventory)",
        },
      };
    }

    const parsed = parseTradeUrl(tradeUrl);
    if (!parsed) {
      return {
        ok: false,
        status: 400,
        body: {
          items: [],
          source: null,
          accountId: null,
          durationMs: 0,
          error: "invalid tradeUrl",
        },
      };
    }

    const partnerSteamId64 = steamId64FromPartner(parsed.partner);
    if (steamIdCheck && normalizeSteamId64(steamIdCheck) !== normalizeSteamId64(partnerSteamId64)) {
      return {
        ok: false,
        status: 400,
        body: {
          items: [],
          source: null,
          accountId: null,
          durationMs: 0,
          error: "steamId does not match tradeUrl partner",
        },
      };
    }

    const canonical = tradeUrlFromParsed(parsed);

    const cached = cache.get(canonical);
    if (cached) {
      logInventoryEvent("cache_hit", {
        itemsCount: cached.items?.length ?? 0,
        error: null,
        accountId: cached.accountId ?? "cache",
        durationMs: 0,
      });
      return {
        ok: true,
        status: 200,
        body: {
          items: cached.items,
          source: "trade",
          accountId: cached.accountId ?? "cache",
          durationMs: 0,
          error: null,
        },
      };
    }

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    logInventoryEvent("start", { jobId, tradeUrl: canonical.slice(0, 120) });

    const work = async () => {
      const slot = await pool.acquire();
      if (!slot) {
        return {
          items: [],
          source: "trade",
          accountId: null,
          durationMs: 0,
          error: "no_worker_account_available",
          _httpStatus: 503,
        };
      }
      const { account, release } = slot;
      let released = false;
      const safeRelease = () => {
        if (released) return;
        released = true;
        release();
      };
      try {
        logInventoryEvent("account_acquired", { jobId, accountId: account.id });
        let outcome = await executeWithAccount(account, canonical, partnerSteamId64);

        const shouldRetryOther =
          !outcome.ok && outcome.timedOut && !outcome.sessionInvalid && outcome.error !== "session_invalid";

        if (shouldRetryOther) {
          logJson("steam_worker_retry_other_account", { jobId, failedAccountId: account.id });
          safeRelease();
          const slot2 = await pool.acquire();
          if (!slot2) {
            return outcome;
          }
          if (slot2.account.id === account.id) {
            slot2.release();
            return outcome;
          }
          try {
            logInventoryEvent("retry_account", { jobId, accountId: slot2.account.id });
            outcome = await executeWithAccount(slot2.account, canonical, partnerSteamId64);
          } finally {
            slot2.release();
          }
        }

        return outcome;
      } finally {
        safeRelease();
      }
    };

    let outcome;
    try {
      outcome = await taskQueue.add(work);
    } catch (e) {
      if (e?.code === "QUEUE_OVERFLOW") {
        logInventoryEvent("queue_overflow", { jobId });
        return {
          ok: false,
          status: 429,
          body: { error: "queue_overflow" },
        };
      }
      throw e;
    }

    if (outcome.error === "no_worker_account_available") {
      logInventoryEvent("no_account", { jobId });
      return {
        ok: false,
        status: 503,
        body: {
          items: [],
          source: "trade",
          accountId: null,
          durationMs: 0,
          error: "no worker account available (busy or all in cooldown)",
        },
      };
    }

    if (outcome.ok) {
      const body = {
        items: outcome.items,
        source: "trade",
        accountId: outcome.accountId,
        durationMs: outcome.durationMs,
        error: null,
      };
      cache.set(canonical, { items: outcome.items, accountId: outcome.accountId });
      logInventoryEvent("complete", {
        jobId,
        accountId: outcome.accountId,
        durationMs: outcome.durationMs,
        itemsCount: outcome.items?.length ?? 0,
        error: null,
      });
      return {
        ok: true,
        status: 200,
        body,
      };
    }

    logInventoryEvent("failed", {
      jobId,
      accountId: outcome.accountId ?? null,
      durationMs: outcome.durationMs ?? 0,
      itemsCount: outcome.items?.length ?? 0,
      error: outcome.error ?? outcome.detail ?? "unknown",
      sessionInvalid: outcome.sessionInvalid,
      timedOut: outcome.timedOut,
    });

    const status = outcome.sessionInvalid ? 401 : outcome.timedOut ? 504 : 502;
    return {
      ok: false,
      status,
      body: {
        items: outcome.items ?? [],
        source: "trade",
        accountId: outcome.accountId ?? null,
        durationMs: outcome.durationMs ?? 0,
        error: outcome.error ?? outcome.detail ?? "unknown",
      },
    };
  };
}
