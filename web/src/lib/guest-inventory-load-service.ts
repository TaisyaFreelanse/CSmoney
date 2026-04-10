import "server-only";

import { fetchGuestInventoryViaTradeOfferPuppeteer } from "@/lib/guest-inventory-puppeteer";
import { runThroughSteamGuestGate } from "@/lib/guest-steam-global-gate";
import {
  getGuestSnapshotEntry,
  markUserRefreshed,
  markUserShortGuestCooldown,
  guestSteamFetchCooldownRemainingMs,
  setCache,
} from "@/lib/inventory-cache";
import {
  fetchGuestInventoryBySteamId64,
  normalizeInventory,
  normalizeSteamId64ForCache,
  parseTradeUrl,
  trySteamId64FromPartner,
} from "@/lib/steam-inventory";
import type { NormalizedItem } from "@/lib/steam-inventory";

/** API добирает asset'ы, которых нет в ответе trade page / частичной пагинации; при совпадении id приоритет у браузера. */
function mergeGuestInventoriesPreferBrowser(browserItems: NormalizedItem[], apiItems: NormalizedItem[]): NormalizedItem[] {
  const m = new Map<string, NormalizedItem>();
  for (const i of apiItems) m.set(i.assetId, i);
  for (const i of browserItems) m.set(i.assetId, i);
  return [...m.values()];
}

const STALE_WARNING_MS = 24 * 60 * 60 * 1000;
const SHORT_UNSTABLE_COOLDOWN_MS = 15 * 60 * 1000;
const RETRY_STEAM_BUSY_MS = 15_000;

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
  const g = await runThroughSteamGuestGate(() => fetchGuestInventoryBySteamId64(steamId64));
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

type GatePuppeteerOpts = { mode: string; attempt: number; skipMinSpacing?: boolean };

async function gatePuppeteer(tradeUrl: string, opts: GatePuppeteerOpts) {
  const skipMinSpacing = opts.skipMinSpacing === true;
  logGuestInvPipeline("puppeteer_invoke", {
    source: "browser",
    mode: opts.mode,
    attempt: opts.attempt,
    skipMinSpacing,
  });
  const t0 = Date.now();
  const g = await runThroughSteamGuestGate(() => fetchGuestInventoryViaTradeOfferPuppeteer(tradeUrl), {
    skipMinSpacing,
  });
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
  });
  if (p.ok) {
    logGuestInvPipeline("puppeteer_success", {
      source: "browser",
      mode: opts.mode,
      attempt: opts.attempt,
      itemCount: browserItemCount ?? 0,
      durationMs: Date.now() - t0,
    });
  } else {
    logGuestInvPipeline("puppeteer_failed", {
      source: "browser",
      mode: opts.mode,
      attempt: opts.attempt,
      reason: p.reason,
      detail: p.detail ?? null,
      durationMs: Date.now() - t0,
    });
  }
  return { kind: "ok" as const, p, queued: g.queued };
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
 * Guest CS2 inventory: всегда сначала trade URL (Puppeteer); Steam Web API — добор к странице или fallback
 * (в т.ч. если нет STEAM_COMMUNITY_COOKIES / браузер отключён).
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

  const respectCooldown = mode === "get" && bypassGuestFetchCooldown !== true;
  const cdRemaining = await guestSteamFetchCooldownRemainingMs(userSteamId);
  if (respectCooldown && cdRemaining > 0) {
    flags.cooldownActive = true;
    flags.nextRefreshAt = nextIso(cdRemaining);
    flags.retryAfterMs = cdRemaining;
    if (snap) {
      return { ok: true, items: snap.items, flags };
    }
    return { ok: false, error: "cooldown_active", flags };
  }

  const steamId64 = snapshotSteamId;

  let items: NormalizedItem[] | null = null;
  let mark2hAfterSuccess = false;
  const skipUserRefreshMark = mode === "force_refresh";

  const tryApiFallback = async (
    setUnstable: boolean,
    meta: { fallbackReason: string; detail?: string },
  ): Promise<GuestInventoryLoadResult | null> => {
    if (setUnstable) applyUnstable(flags);
    logGuestInvPipeline("api_fallback_after_browser", {
      source: "api",
      mode,
      fallbackReason: meta.fallbackReason,
      detail: meta.detail ?? null,
    });
    const g = await gateApi(steamId64, {
      mode,
      role: "fallback",
      fallbackReason: meta.fallbackReason,
      detail: meta.detail,
    });
    if (g.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    if (!g.api.ok) {
      const r = rejectIfApiRateLimited(g.api.error, userSteamId, flags);
      if (r) return r;
      return { ok: false, error: g.api.error, flags };
    }
    items = g.api.items;
    return null;
  };

  /** Добор полного списка через API сразу после trade page (одна логическая загрузка — без лишнего 15s spacing). */
  const supplementFromApiAfterBrowser = async (browserItems: NormalizedItem[]): Promise<NormalizedItem[]> => {
    const browserCount = browserItems.length;
    logGuestInvPipeline("api_supplement_invoke", {
      source: "api",
      mode,
      browserItemCount: browserCount,
    });
    const t0 = Date.now();
    const g = await runThroughSteamGuestGate(() => fetchGuestInventoryBySteamId64(steamId64), {
      skipMinSpacing: true,
    });
    if (!g.ok) {
      logGuestInvPipeline("api_supplement_skipped", {
        source: "api",
        mode,
        reason: "queue_full",
        durationMs: Date.now() - t0,
      });
      return browserItems;
    }
    const api = g.value;
    if (!api.ok) {
      const apiResult: "private" | "unstable" | "error" = api.error.includes("private")
        ? "private"
        : isSteamRateLimited(api.error)
          ? "unstable"
          : "error";
      logGuestInvPipeline("api_supplement_failed", {
        source: "api",
        mode,
        error: api.error,
        durationMs: Date.now() - t0,
      });
      logSteamFetch({
        source: "api",
        result: apiResult,
        durationMs: Date.now() - t0,
        queued: g.queued,
        mode,
        apiRole: "supplement",
        detail: api.error,
      });
      return browserItems;
    }
    const merged = mergeGuestInventoriesPreferBrowser(browserItems, api.items);
    logGuestInvPipeline("api_supplement_merged", {
      source: "api",
      mode,
      browserItemCount: browserCount,
      apiItemCount: api.items.length,
      mergedItemCount: merged.length,
      durationMs: Date.now() - t0,
    });
    logSteamFetch({
      source: "api",
      result: "success",
      durationMs: Date.now() - t0,
      queued: g.queued,
      mode,
      apiRole: "supplement",
      itemCount: api.items.length,
    });
    return merged;
  };

  const g1 = await gatePuppeteer(tradeUrl, { mode, attempt: 1 });
  if (g1.kind === "queue_full") {
    return queueFullResponse(snap, flags);
  }
  const p1 = g1.p;

  if (p1.ok) {
    items = await supplementFromApiAfterBrowser(normalizeInventory(p1.raw, p1.steamId64));
    mark2hAfterSuccess = true;
  } else if (p1.reason === "disabled" || p1.reason === "launch_failed") {
    logGuestInvPipeline("api_primary_no_browser", {
      source: "api",
      mode,
      puppeteerReason: p1.reason,
      detail: p1.detail ?? null,
    });
    const err = await tryApiFallback(p1.reason === "launch_failed", {
      fallbackReason:
        p1.reason === "disabled" ? "puppeteer_disabled_no_session_cookies" : "puppeteer_launch_failed",
      detail: p1.detail,
    });
    if (err) return err;
    mark2hAfterSuccess = true;
  } else if (p1.reason === "rate_limited") {
    await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
    applyUnstable(flags);
    return { ok: false, error: "steam_rate_limit", flags };
  } else if (p1.reason === "not_available") {
    const g2 = await gatePuppeteer(tradeUrl, { mode, attempt: 2, skipMinSpacing: true });
    if (g2.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    const p2 = g2.p;
    if (p2.ok) {
      items = await supplementFromApiAfterBrowser(normalizeInventory(p2.raw, p2.steamId64));
      mark2hAfterSuccess = true;
    } else if (p2.reason === "rate_limited") {
      await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
      applyUnstable(flags);
      return { ok: false, error: "steam_rate_limit", flags };
    } else {
      await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
      applyUnstable(flags);
      const err = await tryApiFallback(false, {
        fallbackReason: "puppeteer_not_available_retry_exhausted",
        detail: p2.detail,
      });
      if (err) return err;
    }
  } else if (p1.reason === "private") {
    const g2 = await gatePuppeteer(tradeUrl, { mode, attempt: 2 });
    if (g2.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    const p2 = g2.p;
    if (p2.ok) {
      items = await supplementFromApiAfterBrowser(normalizeInventory(p2.raw, p2.steamId64));
      mark2hAfterSuccess = true;
    } else if (p2.reason === "rate_limited") {
      await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
      applyUnstable(flags);
      return { ok: false, error: "steam_rate_limit", flags };
    } else if (p2.reason === "private") {
      flags.isPrivate = true;
      if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
      const err = await tryApiFallback(false, {
        fallbackReason: "puppeteer_private_after_retry",
        detail: p2.detail,
      });
      if (err) return err;
    } else {
      const err = await tryApiFallback(p2.reason === "timeout" || p2.reason === "empty", {
        fallbackReason: `puppeteer_private_retry_${p2.reason}`,
        detail: p2.detail,
      });
      if (err) return err;
      mark2hAfterSuccess = true;
    }
  } else if (p1.reason === "cannot_trade") {
    if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
    const err = await tryApiFallback(false, {
      fallbackReason: "puppeteer_cannot_trade",
      detail: p1.detail,
    });
    if (err) return err;
    flags.cannotTrade = true;
  } else if (p1.reason === "empty" || p1.reason === "timeout") {
    const err = await tryApiFallback(true, {
      fallbackReason: `puppeteer_${p1.reason}`,
      detail: p1.detail,
    });
    if (err) return err;
    if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
  } else {
    logGuestInvPipeline("api_fallback_after_browser", {
      source: "api",
      mode,
      fallbackReason: `puppeteer_unhandled_${p1.reason}`,
      detail: p1.detail ?? null,
    });
    const gApi = await gateApi(steamId64, {
      mode,
      role: "fallback",
      fallbackReason: `puppeteer_unhandled_${p1.reason}`,
      detail: p1.detail,
    });
    if (gApi.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    if (!gApi.api.ok) {
      const r = rejectIfApiRateLimited(gApi.api.error, userSteamId, flags);
      if (r) return r;
      return { ok: false, error: gApi.api.error, flags };
    }
    items = gApi.api.items;
    mark2hAfterSuccess = true;
  }

  if (!items) {
    return { ok: false, error: "guest_inventory_unavailable", flags };
  }

  await setCache(snapshotSteamId, items);

  if (!skipUserRefreshMark && mark2hAfterSuccess) {
    await markUserRefreshed(userSteamId);
  }

  return { ok: true, items, flags };
}
