import { fetchTradeInventory } from "../puppeteer/fetchTradeInventory.js";
import { fetchCommunityInventoryPaginated } from "../utils/fetchCommunityInventoryPaginated.js";
import {
  buildWorkerTradeInventoryItems,
  filterTradableMergedRaw,
} from "../utils/inventoryWorkerItemLists.js";
import { buildInventoryMetaV1 } from "../utils/inventoryResponseMeta.js";
import { parseTradeUrl, tradeUrlFromParsed, steamId64FromPartner, normalizeSteamId64 } from "../utils/steamUrl.js";
import { logJson, logInventoryEvent } from "../utils/logger.js";
import { notifySteamAccountIssue, recordTradeFetchOutcome } from "../utils/telegramNotifier.js";
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
    const apiPull = await fetchCommunityInventoryPaginated(partnerSteamId64, account.id);
    if (apiPull.ok) {
      logJson("steam_worker_inventory_api_prefetch_ok", {
        accountId: account.id,
        pages: apiPull.chunks.length,
        paginationComplete: apiPull.meta?.paginationComplete,
        stoppedReason: apiPull.meta?.stoppedReason,
        mergedAssetCount: apiPull.meta?.mergedAssetCount,
        steamTotal: apiPull.meta?.steamTotalInventoryCount ?? null,
      });
    } else {
      logJson("steam_worker_inventory_api_prefetch_skip", {
        accountId: account.id,
        error: apiPull.error,
      });
    }
    const prefetchedInventoryChunks = apiPull.ok ? apiPull.chunks : [];
    const apiInventoryMeta = apiPull.ok ? apiPull.meta : null;

    const r = await fetchTradeInventory({
      tradeUrlCanonical: canonical,
      partnerSteamId64,
      userDataDir: account.userDataDir,
      accountId: account.id,
      taskTimeoutMs: TASK_TIMEOUT_MS,
      prefetchedInventoryChunks,
      apiInventoryMeta,
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
      void notifySteamAccountIssue({
        accountId: account.id,
        error: "session_invalid",
        detail: r.detail || "steam_worker_account_invalidated",
      });
    }
    recordTradeFetchOutcome(account.id, {
      ok: !!r.ok,
      error: r.error ?? null,
      sessionInvalid: !!r.sessionInvalid,
      detail: r.detail ?? null,
      apiPrefetchError: apiPull.ok ? null : (apiPull.error ?? null),
    });
    const apiMetaForResponse = apiPull.ok
      ? { attempted: true, ok: true, ...apiPull.meta }
      : { attempted: true, ok: false, error: apiPull.error };
    return { ...r, durationMs, accountId: account.id, apiMetaForResponse };
  }

  return async function handleInventory(query) {
    const tradeUrl = query.tradeUrl?.trim();
    const steamIdCheck = query.steamId?.trim();

    if (!tradeUrl) {
      const meta = buildInventoryMetaV1({
        apiMeta: { attempted: false, error: "validation" },
        tradeOutcome: null,
      });
      return {
        ok: false,
        status: 400,
        body: {
          items: [],
          raw: null,
          source: null,
          accountId: null,
          durationMs: 0,
          error: "tradeUrl is required (steamId alone is not enough for trade-offer inventory)",
          meta,
        },
      };
    }

    const parsed = parseTradeUrl(tradeUrl);
    if (!parsed) {
      const meta = buildInventoryMetaV1({
        apiMeta: { attempted: false, error: "invalid_trade_url" },
        tradeOutcome: null,
      });
      return {
        ok: false,
        status: 400,
        body: {
          items: [],
          raw: null,
          source: null,
          accountId: null,
          durationMs: 0,
          error: "invalid tradeUrl",
          meta,
        },
      };
    }

    const partnerSteamId64 = steamId64FromPartner(parsed.partner);
    if (steamIdCheck && normalizeSteamId64(steamIdCheck) !== normalizeSteamId64(partnerSteamId64)) {
      const meta = buildInventoryMetaV1({
        apiMeta: { attempted: false, error: "steamId_mismatch" },
        tradeOutcome: null,
      });
      return {
        ok: false,
        status: 400,
        body: {
          items: [],
          raw: null,
          source: null,
          accountId: null,
          durationMs: 0,
          error: "steamId does not match tradeUrl partner",
          meta,
        },
      };
    }

    const canonical = tradeUrlFromParsed(parsed);

    const cached = cache.get(canonical);
    if (cached) {
      /** Legacy in-memory entries (pre-`raw`) must not return 200 without `raw` — orchestrators need merged JSON. */
      if (cached.raw == null || typeof cached.raw !== "object") {
        logInventoryEvent("cache_bust_missing_raw", {
          itemsCount: cached.items?.length ?? 0,
          accountId: cached.accountId ?? "cache",
        });
        cache.delete(canonical);
      } else {
        logInventoryEvent("cache_hit", {
          itemsCount: cached.items?.length ?? 0,
          error: null,
          accountId: cached.accountId ?? "cache",
          durationMs: 0,
        });
        const baseMeta =
          cached.meta && typeof cached.meta === "object"
            ? cached.meta
            : buildInventoryMetaV1({
                apiMeta: { attempted: false, note: "legacy_cache_entry" },
                tradeOutcome: { ok: true },
              });
        const meta = { ...baseMeta, cacheHit: true, schemaVersion: baseMeta.schemaVersion ?? 1 };
        const rawFiltered =
          cached.raw && typeof cached.raw === "object" ? filterTradableMergedRaw(cached.raw) : cached.raw;
        const { items } =
          rawFiltered && typeof rawFiltered === "object"
            ? buildWorkerTradeInventoryItems(rawFiltered)
            : { items: cached.items ?? [] };
        return {
          ok: true,
          status: 200,
          body: {
            items,
            raw: rawFiltered,
            source: "trade",
            accountId: cached.accountId ?? "cache",
            durationMs: 0,
            error: null,
            meta,
          },
        };
      }
    }

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    logInventoryEvent("start", { jobId, tradeUrl: canonical.slice(0, 120) });

    const work = async () => {
      const slot = await pool.acquire();
      if (!slot) {
        return {
          items: [],
          raw: null,
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

        // Second account: timeouts, flaky proxy (chrome-error://), or transient Puppeteer errors.
        const shouldRetryOther =
          !outcome.ok &&
          !outcome.sessionInvalid &&
          outcome.error !== "session_invalid" &&
          (outcome.timedOut ||
            outcome.error === "proxy_error" ||
            outcome.error === "puppeteer_error");

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
          body: {
            items: [],
            raw: null,
            source: "trade",
            accountId: null,
            durationMs: 0,
            error: "queue_overflow",
            meta: buildInventoryMetaV1({
              apiMeta: { attempted: false, error: "queue_overflow" },
              tradeOutcome: null,
            }),
          },
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
          raw: null,
          source: "trade",
          accountId: null,
          durationMs: 0,
          error: "no worker account available (busy or all in cooldown)",
          meta: buildInventoryMetaV1({
            apiMeta: { attempted: false, error: "no_worker_account_available" },
            tradeOutcome: null,
          }),
        },
      };
    }

    if (outcome.ok) {
      const meta = buildInventoryMetaV1({
        cacheHit: false,
        apiMeta: outcome.apiMetaForResponse ?? { attempted: false },
        tradeOutcome: outcome,
      });
      const body = {
        items: outcome.items,
        raw: outcome.raw ?? null,
        source: "trade",
        accountId: outcome.accountId,
        durationMs: outcome.durationMs,
        error: null,
        meta,
      };
      cache.set(canonical, {
        items: outcome.items,
        accountId: outcome.accountId,
        meta,
        raw: outcome.raw ?? null,
      });
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
    const meta = buildInventoryMetaV1({
      cacheHit: false,
      apiMeta: outcome.apiMetaForResponse ?? { attempted: false, error: outcome.error },
      tradeOutcome: outcome,
    });
    return {
      ok: false,
      status,
        body: {
          items: outcome.items ?? [],
          raw: outcome.raw ?? null,
          source: "trade",
          accountId: outcome.accountId ?? null,
          durationMs: outcome.durationMs ?? 0,
          error: outcome.error ?? outcome.detail ?? "unknown",
          meta,
        },
    };
  };
}
