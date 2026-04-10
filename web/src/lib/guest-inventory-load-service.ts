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
  parseTradeUrl,
  steamId64FromPartner,
} from "@/lib/steam-inventory";
import type { NormalizedItem } from "@/lib/steam-inventory";

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

function browserCookiesConfigured(): boolean {
  const v = process.env.STEAM_COMMUNITY_COOKIES?.trim();
  if (!v) return false;
  if (process.env.STEAM_INVENTORY_BROWSER === "0") return false;
  return true;
}

function logSteamFetch(args: {
  source: "browser" | "api";
  result: "success" | "private" | "unstable" | "error" | "skipped_queue_full";
  durationMs: number;
  queued: boolean;
}): void {
  console.log({
    type: "steam_inventory_fetch",
    source: args.source,
    result: args.result,
    duration: args.durationMs,
    queued: args.queued,
  });
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

async function gateApi(steamId64: string) {
  const t0 = Date.now();
  const g = await runThroughSteamGuestGate(() => fetchGuestInventoryBySteamId64(steamId64));
  if (!g.ok) {
    console.log({
      type: "steam_inventory_fetch",
      source: "api",
      result: "skipped_queue_full",
      duration: Date.now() - t0,
      queued: false,
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
  });
  return { kind: "ok" as const, api, queued: g.queued };
}

async function gatePuppeteer(tradeUrl: string, skipMinSpacing?: boolean) {
  const t0 = Date.now();
  const g = await runThroughSteamGuestGate(() => fetchGuestInventoryViaTradeOfferPuppeteer(tradeUrl), {
    skipMinSpacing: skipMinSpacing === true,
  });
  if (!g.ok) {
    console.log({
      type: "steam_inventory_fetch",
      source: "browser",
      result: "skipped_queue_full",
      duration: Date.now() - t0,
      queued: false,
    });
    return { kind: "queue_full" as const };
  }
  const p = g.value;
  logSteamFetch({
    source: "browser",
    result: puppeteerResultKind(p),
    durationMs: Date.now() - t0,
    queued: g.queued,
  });
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
 * Guest CS2 inventory: optional Puppeteer (trade URL) + API fallback, global gate + queue cap.
 */
export async function loadGuestInventoryForUser(args: {
  userSteamId: string;
  tradeUrl: string;
  guestTargetSteamId: string;
  mode: "get" | "force_refresh" | "trade_validate";
}): Promise<GuestInventoryLoadResult> {
  const { userSteamId, tradeUrl, guestTargetSteamId, mode } = args;
  const flags: GuestInventoryLoadFlags = {};

  try {
    return await runGuestInventoryLoad({ userSteamId, tradeUrl, guestTargetSteamId, mode }, flags);
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
  },
  flags: GuestInventoryLoadFlags,
): Promise<GuestInventoryLoadResult> {
  const { userSteamId, tradeUrl, guestTargetSteamId, mode } = args;

  const snap = await getGuestSnapshotEntry(guestTargetSteamId);
  if (snap) {
    const age = Date.now() - snap.fetchedAt;
    if (age > STALE_WARNING_MS) flags.needsRefreshWarning = true;
  }

  const respectCooldown = mode === "get";
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

  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) {
    return { ok: false, error: "invalid_trade_url", flags };
  }
  const steamId64 = steamId64FromPartner(parsed.partner);

  let items: NormalizedItem[] | null = null;
  let mark2hAfterSuccess = false;
  const skipUserRefreshMark = mode === "force_refresh";

  const useBrowser = browserCookiesConfigured();

  const tryApiFallback = async (setUnstable: boolean): Promise<GuestInventoryLoadResult | null> => {
    if (setUnstable) applyUnstable(flags);
    const g = await gateApi(steamId64);
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

  if (useBrowser) {
    const g1 = await gatePuppeteer(tradeUrl);
    if (g1.kind === "queue_full") {
      return queueFullResponse(snap, flags);
    }
    const p1 = g1.p;

    if (p1.ok) {
      items = normalizeInventory(p1.raw, p1.steamId64);
      mark2hAfterSuccess = true;
    } else if (p1.reason === "rate_limited") {
      await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
      applyUnstable(flags);
      return { ok: false, error: "steam_rate_limit", flags };
    } else if (p1.reason === "not_available") {
      const g2 = await gatePuppeteer(tradeUrl, true);
      if (g2.kind === "queue_full") {
        return queueFullResponse(snap, flags);
      }
      const p2 = g2.p;
      if (p2.ok) {
        items = normalizeInventory(p2.raw, p2.steamId64);
        mark2hAfterSuccess = true;
      } else if (p2.reason === "rate_limited") {
        await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
        applyUnstable(flags);
        return { ok: false, error: "steam_rate_limit", flags };
      } else {
        await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
        applyUnstable(flags);
        const err = await tryApiFallback(false);
        if (err) return err;
      }
    } else if (p1.reason === "private") {
      const g2 = await gatePuppeteer(tradeUrl);
      if (g2.kind === "queue_full") {
        return queueFullResponse(snap, flags);
      }
      const p2 = g2.p;
      if (p2.ok) {
        items = normalizeInventory(p2.raw, p2.steamId64);
        mark2hAfterSuccess = true;
      } else if (p2.reason === "rate_limited") {
        await markUserShortGuestCooldown(userSteamId, SHORT_UNSTABLE_COOLDOWN_MS);
        applyUnstable(flags);
        return { ok: false, error: "steam_rate_limit", flags };
      } else if (p2.reason === "private") {
        flags.isPrivate = true;
        if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
        const err = await tryApiFallback(false);
        if (err) return err;
      } else {
        const err = await tryApiFallback(p2.reason === "timeout" || p2.reason === "empty");
        if (err) return err;
        mark2hAfterSuccess = true;
      }
    } else if (p1.reason === "cannot_trade") {
      if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
      const err = await tryApiFallback(false);
      if (err) return err;
      flags.cannotTrade = true;
    } else if (p1.reason === "empty" || p1.reason === "timeout") {
      const err = await tryApiFallback(true);
      if (err) return err;
      if (!skipUserRefreshMark) await markUserRefreshed(userSteamId);
    } else {
      const gApi = await gateApi(steamId64);
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
  } else {
    const gApi = await gateApi(steamId64);
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

  await setCache(guestTargetSteamId, items);

  if (!skipUserRefreshMark && mark2hAfterSuccess) {
    await markUserRefreshed(userSteamId);
  }

  return { ok: true, items, flags };
}
