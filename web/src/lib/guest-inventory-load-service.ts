import "server-only";

import { enrichNewItemsWithCsFloat } from "@/lib/csfloat";
import {
  ensureGuestPuppeteerCookiesLoggedOnce,
  fetchGuestInventoryViaTradeOfferPuppeteer,
} from "@/lib/guest-inventory-puppeteer";
import {
  runThroughSteamGuestApiGate,
  runThroughSteamGuestPuppeteerLaneGate,
} from "@/lib/guest-steam-split-gate";
import {
  markGuestPuppeteerAccountInvalid,
  markGuestSteamProfileSessionInvalid,
  nextGuestPuppeteerAccount,
  recordSteamProfileSuccess,
  type SteamPuppeteerAccount,
} from "@/lib/steam-puppeteer-accounts";
import {
  getGuestSnapshotEntry,
  markUserRefreshed,
  markUserShortGuestCooldown,
  guestSteamFetchCooldownRemainingMs,
  OWNER_FRESH_TTL_MS,
  setCache,
} from "@/lib/inventory-cache";
import {
  fetchGuestInventoryBySteamId64,
  mergeInventoriesPreferApi,
  normalizeInventory,
  normalizeSteamId64ForCache,
  parseTradeUrl,
  trySteamId64FromPartner,
} from "@/lib/steam-inventory";
import type { NormalizedItem } from "@/lib/steam-inventory";

const STALE_WARNING_MS = 24 * 60 * 60 * 1000;
const SHORT_UNSTABLE_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_STEAM_BUSY_MS = 15_000;
/** Не чаще одного фонового refresh на snapshotSteamId за интервал (защита от thundering herd). */
const GUEST_BACKGROUND_REFRESH_MIN_GAP_MS = 120_000;

const guestBackgroundRefreshLastAt = new Map<string, number>();

export type GuestInventoryLoadFlags = {
  steamUnstable?: boolean;
  steamBusy?: boolean;
  isPrivate?: boolean;
  /** Steam trade page reported the account cannot trade; items may still load via API. */
  cannotTrade?: boolean;
  cooldownActive?: boolean;
  skipSteamFetch?: boolean;
  nextRefreshAt?: string;
  /** Suggested client backoff: 15s when Steam pipeline busy; 15m when unstable / rate-limited. */
  retryAfterMs?: number;
  needsRefreshWarning?: boolean;
  /** Основной источник списка: trade-offer (полный), API, или смесь после merge. */
  guestInventoryPrimarySource?: "trade_url" | "api" | "mixed";
  /** Снимок устарел по TTL — запланирован фоновый refresh (ответ не ждёт Steam). */
  backgroundRevalidateScheduled?: boolean;
};

export type GuestInventoryLoadResult =
  | { ok: true; items: NormalizedItem[]; flags: GuestInventoryLoadFlags }
  | { ok: false; error: string; flags: GuestInventoryLoadFlags };

function nextIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

type GuestInvFetchSource = "browser" | "api";

function logSteamFetch(args: {
  source: GuestInvFetchSource;
  result: "success" | "private" | "unstable" | "error" | "skipped_queue_full";
  durationMs: number;
  queued: boolean;
  mode?: string;
  itemCount?: number;
  puppeteerReason?: string;
  apiRole?: "primary" | "fallback" | "supplement";
  fallbackReason?: string;
  detail?: string;
  workerSteamId?: string;
}): void {
  console.log(
    JSON.stringify({
      type: "steam_inventory_fetch",
      source: args.source,
      result: args.result,
      durationMs: args.durationMs,
      queued: args.queued,
      ...(args.mode != null ? { mode: args.mode } : {}),
      ...(args.itemCount != null ? { itemCount: args.itemCount } : {}),
      ...(args.puppeteerReason != null ? { puppeteerReason: args.puppeteerReason } : {}),
      ...(args.apiRole != null ? { apiRole: args.apiRole } : {}),
      ...(args.fallbackReason != null ? { fallbackReason: args.fallbackReason } : {}),
      ...(args.detail != null ? { detail: args.detail } : {}),
      ...(args.workerSteamId != null ? { workerSteamId: args.workerSteamId } : {}),
    }),
  );
}

function logGuestInvPipeline(
  step: string,
  payload: Record<string, string | number | boolean | null | undefined>,
): void {
  console.log(JSON.stringify({ type: "guest_inv_pipeline", step, ...payload, ts: Date.now() }));
}

function puppeteerResultKind(
  p: Awaited<ReturnType<typeof fetchGuestInventoryViaTradeOfferPuppeteer>>,
): "success" | "private" | "unstable" | "error" {
  if (p.ok) return "success";
  if (p.reason === "private") return "private";
  if (p.reason === "cannot_trade") return "error";
  if (p.reason === "session_invalid") return "unstable";
  if (
    p.reason === "not_available" ||
    p.reason === "timeout" ||
    p.reason === "empty" ||
    p.reason === "rate_limited"
  ) {
    return "unstable";
  }
  return "error";
}

function isSteamRateLimited(error: string): boolean {
  return error === "steam_rate_limit" || error.includes("429") || error.includes("rate_limit");
}

function applyUnstable(flags: GuestInventoryLoadFlags): void {
  flags.steamUnstable = true;
  flags.retryAfterMs = SHORT_UNSTABLE_COOLDOWN_MS;
}

function rejectIfApiRateLimited(
  error: string,
  userSteamId: string,
  flags: GuestInventoryLoadFlags,
): GuestInventoryLoadResult | null {
  if (!isSteamRateLimited(error)) return null;
  void markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
  applyUnstable(flags);
  return { ok: false, error, flags };
}

type GateApiCtx = {
  mode: string;
  role?: "primary" | "fallback" | "supplement";
  fallbackReason?: string;
  detail?: string;
};

async function gateApi(steamId64: string, ctx: GateApiCtx) {
  logGuestInvPipeline("api_invoke", {
    source: "api",
    mode: ctx.mode,
    apiRole: ctx.role ?? "primary",
    fallbackReason: ctx.fallbackReason ?? null,
  });
  const t0 = Date.now();
  const g = await runThroughSteamGuestApiGate(() => fetchGuestInventoryBySteamId64(steamId64));
  if (!g.ok) {
    logSteamFetch({
      source: "api",
      result: "skipped_queue_full",
      durationMs: Date.now() - t0,
      queued: false,
      mode: ctx.mode,
      apiRole: ctx.role,
      fallbackReason: ctx.fallbackReason,
    });
    return { kind: "queue_full" as const };
  }
  const api = g.value;
  const ok = api.ok;
  const apiResult: "success" | "private" | "unstable" | "error" = ok
    ? "success"
    : api.error.includes("private")
      ? "private"
      : isSteamRateLimited(api.error)
        ? "unstable"
        : "error";
  logSteamFetch({
    source: "api",
    result: apiResult,
    durationMs: Date.now() - t0,
    queued: g.queued,
    mode: ctx.mode,
    apiRole: ctx.role,
    fallbackReason: ctx.fallbackReason,
    itemCount: ok ? api.items.length : undefined,
    detail: ok ? undefined : api.error,
  });
  return { kind: "ok" as const, api, queued: g.queued };
}

type GatePuppeteerOpts = {
  mode: string;
  attempt: number;
  skipMinSpacing?: boolean;
  /** Явный worker; иначе {@link nextGuestPuppeteerAccount}. */
  account?: SteamPuppeteerAccount | null;
};

async function gatePuppeteer(tradeUrl: string, opts: GatePuppeteerOpts) {
  const skipMinSpacing = opts.skipMinSpacing === true;
  const acc = opts.account !== undefined ? opts.account : nextGuestPuppeteerAccount();
  const lane = acc?.laneId ?? "default";
  /* puppeteer_invoke: см. guest-inventory-puppeteer (guest_inv_puppeteer). */
  const t0 = Date.now();
  const g = await runThroughSteamGuestPuppeteerLaneGate(
    lane,
    () =>
      fetchGuestInventoryViaTradeOfferPuppeteer(tradeUrl, {
        steamCommunityCookies: acc?.cookies,
        userDataDir: acc?.userDataDir,
        accountId: acc?.accountId,
        workerLaneId: acc?.laneId,
      }),
    { skipMinSpacing },
  );
  if (!g.ok) {
    logSteamFetch({
      source: "browser",
      result: "skipped_queue_full",
      durationMs: Date.now() - t0,
      queued: false,
      mode: opts.mode,
    });
    return { kind: "queue_full" as const };
  }
  const p = g.value;
  const kind = puppeteerResultKind(p);
  const browserItemCount = p.ok ? normalizeInventory(p.raw, p.steamId64).length : undefined;
  logSteamFetch({
    source: "browser",
    result: kind,
    durationMs: Date.now() - t0,
    queued: g.queued,
    mode: opts.mode,
    puppeteerReason: p.ok ? undefined : p.reason,
    detail: p.ok ? undefined : p.detail,
    itemCount: browserItemCount,
    workerSteamId: acc?.laneId,
  });
  /* puppeteer_success / puppeteer_failed: см. guest-inventory-puppeteer (guest_inv_puppeteer). */
  return { kind: "ok" as const, p, queued: g.queued, account: acc };
}

function puppeteerFailureInvalidatesAccount(
  p: Awaited<ReturnType<typeof fetchGuestInventoryViaTradeOfferPuppeteer>>,
): boolean {
  if (p.ok) return false;
  return p.reason === "timeout" || p.reason === "empty" || p.reason === "not_available";
}

function queueFullResponse(
  snap: { items: NormalizedItem[]; fetchedAt: number } | null,
  flags: GuestInventoryLoadFlags,
): GuestInventoryLoadResult {
  flags.cooldownActive = true;
  flags.skipSteamFetch = true;
  flags.retryAfterMs = RETRY_STEAM_BUSY_MS;
  if (snap) {
    const age = Date.now() - snap.fetchedAt;
    if (age > STALE_WARNING_MS) flags.needsRefreshWarning = true;
    return { ok: true, items: snap.items, flags };
  }
  flags.steamBusy = true;
  return { ok: false, error: "steam_busy", flags };
}

/**
 * Guest CS2 inventory: сначала Steam Community API (пагинация, float/phase), затем trade URL (Puppeteer) для добора,
 * merge по assetId с приоритетом API; CSFloat — только если у предмета ещё нет float (кэш по inspect link).
 */
export async function loadGuestInventoryForUser(args: {
  userSteamId: string;
  tradeUrl: string;
  guestTargetSteamId: string;
  mode: "get" | "force_refresh" | "trade_validate";
  /** Админ с чужой trade URL: не режем загрузку кулдауном, привязанным к session SteamID. */
  bypassGuestFetchCooldown?: boolean;
}): Promise<GuestInventoryLoadResult> {
  const { userSteamId, tradeUrl, guestTargetSteamId, mode, bypassGuestFetchCooldown } = args;
  const flags: GuestInventoryLoadFlags = {};

  try {
    return await runGuestInventoryLoad(
      { userSteamId, tradeUrl, guestTargetSteamId, mode, bypassGuestFetchCooldown },
      flags,
    );
  } catch (e) {
    console.error("[guest-inv-load] unhandled", e);
    return { ok: false, error: "guest_inventory_unavailable", flags };
  }
}

async function runGuestInventoryLoad(
  args: {
    userSteamId: string;
    tradeUrl: string;
    guestTargetSteamId: string;
    mode: "get" | "force_refresh" | "trade_validate";
    bypassGuestFetchCooldown?: boolean;
  },
  flags: GuestInventoryLoadFlags,
): Promise<GuestInventoryLoadResult> {
  const { userSteamId, tradeUrl, guestTargetSteamId, mode, bypassGuestFetchCooldown } = args;

  const parsedEarly = parseTradeUrl(tradeUrl.trim());
  if (!parsedEarly) {
    return { ok: false, error: "invalid_trade_url", flags };
  }
  const urlDerived64 = trySteamId64FromPartner(parsedEarly.partner);
  if (!urlDerived64) {
    return { ok: false, error: "invalid_trade_url", flags };
  }
  /** Ключ снимка инвентаря = SteamID64 из trade URL (источник истины), нормализованный. */
  const snapshotSteamId = normalizeSteamId64ForCache(urlDerived64);
  const passedNorm = normalizeSteamId64ForCache(guestTargetSteamId);
  if (snapshotSteamId !== passedNorm) {
    console.warn("[guest-inv-load] snapshotSteamId from trade URL !== guestTargetSteamId from caller", {
      sessionSteamIdNorm: normalizeSteamId64ForCache(userSteamId),
      guestTargetSteamIdPassed: guestTargetSteamId,
      snapshotSteamId,
    });
  }

  const snap = await getGuestSnapshotEntry(snapshotSteamId);
  if (snap) {
    const age = Date.now() - snap.fetchedAt;
    if (age > STALE_WARNING_MS) flags.needsRefreshWarning = true;
  }

  /** GET с уже сохранённым снимком: не трогаем Puppeteer/Web API (избегаем задержки при каждом заходе / смене языка). */
  if (mode === "get" && snap) {
    flags.skipSteamFetch = true;
    const ageMs = Date.now() - snap.fetchedAt;
    logGuestInvPipeline("cache_hit_skip_steam", {
      source: "guest_snapshot",
      mode,
      itemCount: snap.items.length,
      ageMs,
    });
    if (ageMs > OWNER_FRESH_TTL_MS) {
      const now = Date.now();
      const last = guestBackgroundRefreshLastAt.get(snapshotSteamId) ?? 0;
      if (now - last >= GUEST_BACKGROUND_REFRESH_MIN_GAP_MS) {
        guestBackgroundRefreshLastAt.set(snapshotSteamId, now);
        flags.backgroundRevalidateScheduled = true;
        logGuestInvPipeline("cache_stale_background_refresh_scheduled", {
          source: "guest_snapshot",
          ageMs,
          ttlMs: OWNER_FRESH_TTL_MS,
          snapshotSteamId,
        });
        void loadGuestInventoryForUser({
          userSteamId,
          tradeUrl,
          guestTargetSteamId,
          mode: "force_refresh",
          bypassGuestFetchCooldown: true,
        }).catch((e) => console.error("[guest-inv-load] background refresh failed", e));
      } else {
        logGuestInvPipeline("cache_stale_background_refresh_skipped_debounce", {
          source: "guest_snapshot",
          ageMs,
          gapMs: GUEST_BACKGROUND_REFRESH_MIN_GAP_MS,
        });
      }
    }
    return { ok: true, items: snap.items, flags };
  }

  const respectCooldown = mode === "get" && bypassGuestFetchCooldown !== true;
  const cdRemaining = await guestSteamFetchCooldownRemainingMs(userSteamId);
  if (respectCooldown && cdRemaining > 0) {
    flags.cooldownActive = true;
    flags.nextRefreshAt = nextIso(cdRemaining);
    flags.retryAfterMs = cdRemaining;
    return { ok: false, error: "cooldown_active", flags };
  }

  ensureGuestPuppeteerCookiesLoggedOnce();

  const steamId64 = snapshotSteamId;
  const pipelineT0 = Date.now();
  let mark2hAfterSuccess = false;
  const skipUserRefreshMark = mode === "force_refresh";

  const gApi0 = await gateApi(steamId64, { mode, role: "primary" });
  if (gApi0.kind === "queue_full") {
    return queueFullResponse(snap, flags);
  }

  const apiRes = gApi0.api;
  const apiItems: NormalizedItem[] = apiRes.ok ? apiRes.items : [];
  const apiAssetIds = new Set(apiItems.map((i) => i.assetId));

  logGuestInvPipeline("api_first_complete", {
    mode,
    apiOk: apiRes.ok,
    apiItemCount: apiItems.length,
    apiError: apiRes.ok ? null : apiRes.error,
  });

  if (!apiRes.ok) {
    const r = rejectIfApiRateLimited(apiRes.error, userSteamId, flags);
    if (r) return r;
  }

  const finalizeSuccess = async (
    merged: NormalizedItem[],
    primary: NonNullable<GuestInventoryLoadFlags["guestInventoryPrimarySource"]>,
    puppeteerWorker?: SteamPuppeteerAccount | null,
  ): Promise<GuestInventoryLoadResult> => {
    if (
      puppeteerWorker &&
      (primary === "mixed" || primary === "trade_url")
    ) {
      recordSteamProfileSuccess(puppeteerWorker.laneId, puppeteerWorker.accountId);
    }
    const cs = await enrichNewItemsWithCsFloat(merged, apiRes.ok ? apiAssetIds : new Set<string>());
    logGuestInvPipeline("guest_inv_load_complete", {
      mode,
      snapshotSteamId,
      primarySource: primary,
      totalItems: merged.length,
      apiItemCount: apiItems.length,
      newWithoutApi: cs.newWithoutApi,
      csfloatSent: cs.sentToCsfloat,
      csfloatCacheHits: cs.cacheHits,
      csfloatEnriched: cs.enriched,
      durationMs: Date.now() - pipelineT0,
    });
    console.log(
      JSON.stringify({
        type: "guest_inv_task",
        status: "done",
        snapshotSteamId,
        primarySource: primary,
        totalItems: merged.length,
        newWithoutApi: cs.newWithoutApi,
        csfloatSent: cs.sentToCsfloat,
        durationMs: Date.now() - pipelineT0,
      }),
    );
    await setCache(snapshotSteamId, merged);
    if (!skipUserRefreshMark && mark2hAfterSuccess) {
      await markUserRefreshed(userSteamId);
    }
    flags.guestInventoryPrimarySource = primary;
    return { ok: true, items: merged, flags };
  };

  const maybeInvalidateAccount = (
    acc: SteamPuppeteerAccount | null | undefined,
    p: Awaited<ReturnType<typeof fetchGuestInventoryViaTradeOfferPuppeteer>>,
  ) => {
    if (!acc || p.ok) return;
    if (p.reason === "session_invalid") {
      markGuestSteamProfileSessionInvalid(acc.laneId, p.detail ?? "session_invalid", acc.accountId);
      return;
    }
    if (puppeteerFailureInvalidatesAccount(p)) {
      markGuestPuppeteerAccountInvalid(acc.laneId, p.reason);
    }
  };

  const accFirst = nextGuestPuppeteerAccount();
  const g1 = await gatePuppeteer(tradeUrl, { mode, attempt: 1, account: accFirst });
  if (g1.kind === "queue_full") {
    return queueFullResponse(snap, flags);
  }
  const p1 = g1.p;
  maybeInvalidateAccount(g1.account, p1);

  if (p1.ok) {
    const browserItems = normalizeInventory(p1.raw, p1.steamId64);
    const merged = mergeInventoriesPreferApi(apiItems, browserItems);
    const primary: GuestInventoryLoadFlags["guestInventoryPrimarySource"] =
      apiItems.length > 0 ? "mixed" : "trade_url";
    mark2hAfterSuccess = true;
    return finalizeSuccess(merged, primary, g1.account ?? null);
  }

  if (p1.reason === "disabled" || p1.reason === "launch_failed") {
    logGuestInvPipeline("puppeteer_skipped_browser_down", {
      mode,
      puppeteerReason: p1.reason,
      detail: p1.detail ?? null,
    });
    if (!apiRes.ok) {
      return { ok: false, error: apiRes.error, flags };
    }
    mark2hAfterSuccess = true;
    return finalizeSuccess([...apiItems], "api");
  }

  if (p1.reason === "rate_limited") {
    await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
    applyUnstable(flags);
    console.log(
      JSON.stringify({
        type: "guest_inv_task",
        status: "error",
        error: "steam_rate_limit",
        snapshotSteamId,
        durationMs: Date.now() - pipelineT0,
      }),
    );
    return { ok: false, error: "steam_rate_limit", flags };
  }

  if (p1.reason === "session_invalid") {
    applyUnstable(flags);
    if (!apiRes.ok) {
      return { ok: false, error: apiRes.error, flags };
    }
    if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
    mark2hAfterSuccess = true;
    return finalizeSuccess([...apiItems], "api");
  }

  if (p1.reason === "not_available") {
    const acc2 = nextGuestPuppeteerAccount();
    const g2 = await gatePuppeteer(tradeUrl, { mode, attempt: 2, skipMinSpacing: true, account: acc2 });
    if (g2.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    const p2 = g2.p;
    maybeInvalidateAccount(g2.account, p2);
    if (p2.ok) {
      const browserItems = normalizeInventory(p2.raw, p2.steamId64);
      const merged = mergeInventoriesPreferApi(apiItems, browserItems);
      const primary: GuestInventoryLoadFlags["guestInventoryPrimarySource"] =
        apiItems.length > 0 ? "mixed" : "trade_url";
      mark2hAfterSuccess = true;
      return finalizeSuccess(merged, primary, g2.account ?? null);
    }
    if (p2.reason === "rate_limited") {
      await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
      applyUnstable(flags);
      return { ok: false, error: "steam_rate_limit", flags };
    }
    await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
    applyUnstable(flags);
    if (!apiRes.ok) {
      return { ok: false, error: "guest_inventory_unavailable", flags };
    }
    mark2hAfterSuccess = true;
    return finalizeSuccess([...apiItems], "api");
  }

  if (p1.reason === "private") {
    const acc2 = nextGuestPuppeteerAccount();
    const g2 = await gatePuppeteer(tradeUrl, { mode, attempt: 2, account: acc2 });
    if (g2.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    const p2 = g2.p;
    maybeInvalidateAccount(g2.account, p2);
    if (p2.ok) {
      const browserItems = normalizeInventory(p2.raw, p2.steamId64);
      const merged = mergeInventoriesPreferApi(apiItems, browserItems);
      const primary: GuestInventoryLoadFlags["guestInventoryPrimarySource"] =
        apiItems.length > 0 ? "mixed" : "trade_url";
      mark2hAfterSuccess = true;
      return finalizeSuccess(merged, primary, g2.account ?? null);
    }
    if (p2.reason === "rate_limited") {
      await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
      applyUnstable(flags);
      return { ok: false, error: "steam_rate_limit", flags };
    }
    if (p2.reason === "private") {
      flags.isPrivate = true;
      if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
      if (!apiRes.ok) {
        return { ok: false, error: "private_inventory", flags };
      }
      mark2hAfterSuccess = true;
      return finalizeSuccess([...apiItems], "api");
    }
    if (!apiRes.ok) {
      return { ok: false, error: "guest_inventory_unavailable", flags };
    }
    mark2hAfterSuccess = true;
    return finalizeSuccess([...apiItems], "api");
  }

  if (p1.reason === "cannot_trade") {
    if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
    flags.cannotTrade = true;
    if (!apiRes.ok) {
      return { ok: false, error: apiRes.error, flags };
    }
    mark2hAfterSuccess = true;
    return finalizeSuccess([...apiItems], "api");
  }

  if (p1.reason === "empty" || p1.reason === "timeout") {
    applyUnstable(flags);
    if (!apiRes.ok) {
      if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
      return { ok: false, error: apiRes.error, flags };
    }
    if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
    mark2hAfterSuccess = true;
    return finalizeSuccess([...apiItems], "api");
  }

  logGuestInvPipeline("puppeteer_unhandled", {
    mode,
    reason: p1.reason,
    detail: p1.detail ?? null,
  });
  if (!apiRes.ok) {
    return { ok: false, error: apiRes.error, flags };
  }
  mark2hAfterSuccess = true;
  return finalizeSuccess([...apiItems], "api");
}
