import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";

import type { Browser, Page, PuppeteerNode } from "puppeteer";

import { recordTradeOfferPuppeteerOutcome } from "@/lib/puppeteer-trade-offer-metrics";
import { normalizeSteamId64ForCache, parseTradeUrl, steamId64FromPartner } from "@/lib/steam-community-url";

const LOG = "[guest-inv-puppeteer]";

/** CS2 in-game context on trade offer page (economy_trade.js). */
const TARGET_APPID = 730;
const TARGET_CONTEXTID = 2;

/** Large inventories: trade UI + partner XHR unlock + paginated XHRs. */
const MAX_BROWSER_MS = 85_000;
const GOTO_TIMEOUT_MS = 25_000;
const TRADE_UI_WAIT_MS = 55_000;
/** Wait for `/tradeoffer/new/partnerinventory` (730/2) after selecting partner context. */
const PARTNER_CS2_XHR_WAIT_MS = 45_000;
/** After first empty CS2 partner XHR, wait this long for a non-empty follow-up (pagination). */
const PARTNER_CS2_EMPTY_SETTLE_MS = 2_500;

/** After last inventory JSON, wait this long before treating pagination as finished. */
const INVENTORY_JSON_IDLE_MS = 1100;
/** После положительного CS2 partnerinventory — короче ждём стабилизацию пагинации. */
const INVENTORY_JSON_IDLE_AFTER_POSITIVE_MS = 850;
/** If `more_items` stays true but no new JSON arrives, stop and let API merge complete the list. */
const INVENTORY_JSON_STALL_WHILE_MORE_MS = 2800;

export type TradeOfferPuppeteerLogProfile = "guest" | "owner";

function logTradeOfferPuppeteer(
  profile: TradeOfferPuppeteerLogProfile,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  const type = profile === "owner" ? "owner_inv_puppeteer" : "guest_inv_puppeteer";
  console.log(JSON.stringify({ type, event, ts: Date.now(), ...payload }));
}

let guestPuppeteerCookiesPresenceLogged = false;

function logPartnerInventorySummary(
  profile: TradeOfferPuppeteerLogProfile,
  payload: {
    totalItems: number;
    xhrCount: number;
    maxItems: number;
    hadPositiveItems: boolean;
    usedWindowFallback: boolean;
    steamId64: string;
    outcome: "success" | "failed";
  },
): void {
  logTradeOfferPuppeteer(profile, "partner_inventory_summary", payload);
}

function countItemsInInventoryJson(o: Record<string, unknown>): number {
  if (Array.isArray(o.assets)) return o.assets.length;
  if (o.rgInventory && typeof o.rgInventory === "object") {
    return Object.keys(o.rgInventory as Record<string, unknown>).length;
  }
  return 0;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type PuppeteerGuestInventoryResult =
  | { ok: true; raw: unknown; steamId64: string; source: "trade_url" }
  | {
      ok: false;
      reason:
        | "disabled"
        | "launch_failed"
        | "not_available"
        | "private"
        | "cannot_trade"
        | "empty"
        | "timeout"
        | "invalid_trade_url"
        | "unknown"
        | "rate_limited";
      detail?: string;
    };

type CookiesDisabledReason = "no_steam_community_cookies" | "steam_inventory_browser_disabled";

function cookiesDisabledReason(): CookiesDisabledReason | null {
  const v = process.env.STEAM_COMMUNITY_COOKIES?.trim();
  if (!v) return "no_steam_community_cookies";
  if (process.env.STEAM_INVENTORY_BROWSER === "0") return "steam_inventory_browser_disabled";
  return null;
}

function cookiesEnabled(): boolean {
  return cookiesDisabledReason() === null;
}

/** Один раз за процесс: видно в логах деплоя, есть ли cookies для Puppeteer. */
export function ensureGuestPuppeteerCookiesLoggedOnce(): void {
  if (guestPuppeteerCookiesPresenceLogged) return;
  guestPuppeteerCookiesPresenceLogged = true;
  logTradeOfferPuppeteer("guest", "puppeteer_cookies_present", { present: cookiesEnabled() });
}

export type TradeOfferPuppeteerOptions = { logProfile?: TradeOfferPuppeteerLogProfile };

/** Same path as scripts/install-chrome-for-puppeteer.mjs + render-start.mjs (Render slug includes web/). */
function ensurePuppeteerCacheDir(): void {
  if (process.env.PUPPETEER_CACHE_DIR?.trim()) return;
  process.env.PUPPETEER_CACHE_DIR = path.resolve(process.cwd(), ".puppeteer-chrome");
}

function parseCookieHeader(header: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

function descKeyFromRow(row: Record<string, unknown>): string {
  return `${row.classid}_${row.instanceid ?? "0"}`;
}

/**
 * Merges Steam inventory JSON chunks: new `/inventory/.../730/...` shape and trade-window
 * `/tradeoffer/new/partnerinventory` shape (`rgInventory` / `rgDescriptions`).
 */
function mergeCommunityInventoryJson(chunks: unknown[]): unknown {
  const allAssets: unknown[] = [];
  const allAssetProps: unknown[] = [];
  const descMap = new Map<string, unknown>();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const j = chunk as Record<string, unknown>;

    if (Array.isArray(j.assets)) {
      allAssets.push(...j.assets);
    } else if (j.rgInventory && typeof j.rgInventory === "object") {
      const rgInv = j.rgInventory as Record<string, Record<string, unknown>>;
      for (const a of Object.values(rgInv)) {
        if (!a || typeof a !== "object") continue;
        allAssets.push({
          assetid: String(a.id ?? a.assetid ?? ""),
          classid: a.classid,
          instanceid: a.instanceid ?? "0",
          amount: a.amount,
        });
      }
    }

    if (Array.isArray(j.asset_properties)) allAssetProps.push(...j.asset_properties);

    if (Array.isArray(j.descriptions)) {
      for (const d of j.descriptions) {
        const row = d as Record<string, unknown>;
        const key = descKeyFromRow(row);
        if (!descMap.has(key)) descMap.set(key, d);
      }
    }
    if (j.rgDescriptions && typeof j.rgDescriptions === "object") {
      const rgDesc = j.rgDescriptions as Record<string, unknown>;
      for (const d of Object.values(rgDesc)) {
        const row = d as Record<string, unknown>;
        if (!row || typeof row !== "object") continue;
        const key = descKeyFromRow(row);
        if (!descMap.has(key)) descMap.set(key, d);
      }
    }
  }

  const byAssetId = new Map<string, unknown>();
  for (const a of allAssets) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const id = String(ar.assetid ?? ar.id ?? "").trim();
    if (!id) continue;
    if (!byAssetId.has(id)) byAssetId.set(id, a);
  }

  return {
    assets: [...byAssetId.values()],
    descriptions: Array.from(descMap.values()),
    asset_properties: allAssetProps,
  };
}

function classifyPageText(pageText: string): "not_available" | "private" | "cannot_trade" | null {
  const t = pageText.toLowerCase();
  if (
    t.includes("this inventory is not available") ||
    t.includes("inventory is not available") ||
    t.includes("the inventory you are trying to view is not available")
  ) {
    return "not_available";
  }
  if (t.includes("inventory is private") || t.includes("this profile is private") || t.includes("profile is private")) {
    return "private";
  }
  if (
    t.includes("trade ban") ||
    t.includes("cannot trade") ||
    t.includes("not allowed to trade") ||
    t.includes("trading is suspended") ||
    t.includes("account may not trade")
  ) {
    return "cannot_trade";
  }
  return null;
}

/** Heuristics: logged-in trade page blocked by Guard / email / login wall (no partner XHR). */
async function detectTradeGuardOrConfirmation(page: Page): Promise<{ likelyBlocked: boolean; hints: string[] }> {
  return page
    .evaluate(() => {
      const hints: string[] = [];
      const t = (document.body?.innerText ?? "").toLowerCase();
      const html = (document.documentElement?.innerHTML ?? "").toLowerCase();
      if (t.includes("steam guard") || html.includes("steam_guard")) hints.push("steam_guard");
      if (t.includes("confirm on your mobile") || t.includes("mobile authenticator")) hints.push("mobile_confirm");
      if (t.includes("verify your email") || t.includes("email verification")) hints.push("email_verify");
      if (t.includes("javascript is disabled") || t.includes("javascript must be enabled")) hints.push("js_disabled_msg");
      if (document.querySelector("#loginContent, .login_modal, .newlogindialog_ModalContainer")) hints.push("login_modal_dom");
      return { likelyBlocked: hints.length > 0, hints };
    })
    .catch(() => ({ likelyBlocked: false, hints: [] }));
}

function trySteamId64FromSteamLoginSecureCookie(cookieHeader: string): string | null {
  const pairs = parseCookieHeader(cookieHeader);
  for (const p of pairs) {
    if (p.name.toLowerCase() !== "steamloginsecure") continue;
    try {
      const dec = decodeURIComponent(p.value);
      const first = dec.includes("||") ? dec.split("||")[0]!.trim() : dec.split("|")[0]!.trim();
      if (first && /^\d+$/.test(first)) return normalizeSteamId64ForCache(first);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function classifyDom(page: Page): Promise<{
  profilePrivate: boolean;
  tradeBlocked: boolean;
  inventoryUnavailable: boolean;
}> {
  return page
    .evaluate(() => {
      const body = document.body;
      const cls = body?.className?.toString() ?? "";
      const html = document.documentElement?.className?.toString() ?? "";
      const combined = `${cls} ${html}`.toLowerCase();
      const profilePrivate =
        combined.includes("private_profile") ||
        !!document.querySelector(".profile_private_profile") ||
        !!document.querySelector(".private_profile");
      const text = (body?.innerText ?? "").toLowerCase();
      return {
        profilePrivate,
        tradeBlocked:
          text.includes("trade ban") ||
          text.includes("cannot trade") ||
          text.includes("not allowed to trade") ||
          text.includes("trading is suspended"),
        inventoryUnavailable:
          text.includes("this inventory is not available") ||
          text.includes("inventory is not available"),
      };
    })
    .catch(() => ({
      profilePrivate: false,
      tradeBlocked: false,
      inventoryUnavailable: false,
    }));
}

async function waitForTradeUi(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { TradePageSelectInventory?: unknown }).TradePageSelectInventory ===
        "function" &&
      (window as unknown as { UserThem?: unknown }).UserThem != null &&
      (document.querySelector("#inventories") != null ||
        document.querySelector(".trade_content") != null ||
        document.querySelector("#tradeoffer_items") != null),
    { timeout: Math.max(3000, timeoutMs), polling: 400 },
  );
}

type PartnerCs2SelectResult = {
  tradePageSelectInventoryCalled: boolean;
  jqueryTheirAppSelect: boolean;
  jqueryTheirContextSelect: boolean;
  loadInventoryFallback: boolean;
  beforeThemStatus: { appid: unknown; contextid: unknown } | null;
  afterThemStatus: { appid: unknown; contextid: unknown } | null;
  errors: string[];
};

async function selectPartnerCs2Inventory(page: Page): Promise<PartnerCs2SelectResult> {
  return page.evaluate(
    (appid, ctxid) => {
      /* Browser-only: Steam exposes $J / jQuery on trade pages. */
      const w = window as unknown as Record<string, unknown> & {
        TradePageSelectInventory?: (user: unknown, a: number, c: number) => void;
        UserThem?: { loadInventory?: (a: number, c: number) => void };
        g_rgCurrentTradeStatus?: { them?: Record<string, unknown> };
      };
      type Jq = {
        length: number;
        find: (s: string) => Jq;
        val: (v?: string) => Jq;
        trigger: (ev: string) => Jq;
        data: (k: string) => unknown;
      };
      const $J = (w.$J ?? w.jQuery) as ((sel: string) => Jq) | undefined;
      const out: PartnerCs2SelectResult = {
        tradePageSelectInventoryCalled: false,
        jqueryTheirAppSelect: false,
        jqueryTheirContextSelect: false,
        loadInventoryFallback: false,
        beforeThemStatus: null,
        afterThemStatus: null,
        errors: [],
      };

      try {
        const ts = w.g_rgCurrentTradeStatus;
        if (ts?.them && typeof ts.them === "object") {
          out.beforeThemStatus = {
            appid: ts.them.appid ?? ts.them.appId ?? null,
            contextid: ts.them.contextid ?? ts.them.contextId ?? null,
          };
        }
      } catch (e) {
        out.errors.push(String(e));
      }

      try {
        if (typeof w.TradePageSelectInventory === "function" && w.UserThem) {
          w.TradePageSelectInventory(w.UserThem, appid, ctxid);
          out.tradePageSelectInventoryCalled = true;
          try {
            w.TradePageSelectInventory(w.UserThem, appid, ctxid);
          } catch {
            /* second nudge for economy_trade.js race */
          }
        }
      } catch (e) {
        out.errors.push(`TradePageSelectInventory: ${e}`);
      }

      if (!out.tradePageSelectInventoryCalled) {
        try {
          if ($J) {
            const $app = $J("#responsive_tab_select_theirinventory select");
            if ($app.length && $app.find(`option[value="${appid}"]`).length) {
              $app.val(String(appid)).trigger("change");
              out.jqueryTheirAppSelect = true;
            }
            const $ctx = $J("#responsive_tab_select_theircontexts select");
            if ($ctx.length) {
              const dataApp = $ctx.data("appid");
              if (dataApp == null || Number(dataApp) === Number(appid)) {
                $ctx.val(String(ctxid)).trigger("change");
                out.jqueryTheirContextSelect = true;
              }
            }
          } else if (typeof w.UserThem?.loadInventory === "function") {
            w.UserThem.loadInventory(appid, ctxid);
            out.loadInventoryFallback = true;
          }
        } catch (e) {
          out.errors.push(`fallback_select: ${e}`);
        }
      }

      try {
        const ts2 = w.g_rgCurrentTradeStatus;
        if (ts2?.them && typeof ts2.them === "object") {
          out.afterThemStatus = {
            appid: ts2.them.appid ?? ts2.them.appId ?? null,
            contextid: ts2.them.contextid ?? ts2.them.contextId ?? null,
          };
        }
      } catch {
        /* ignore */
      }

      return out;
    },
    TARGET_APPID,
    TARGET_CONTEXTID,
  );
}

/**
 * Только запросы инвентаря партнёра по trade URL: partnerinventory (query partner) или
 * /inventory/<steam64>/730/… / profiles/<steam64>/… где steam64 совпадает с partner из ссылки.
 * Собственный инвентарь (UserYou / XHR на steamid сессии) отбрасываем.
 */
function isPartnerInventoryRequestUrl(url: string, expectedPartnerSteam64: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith("steamcommunity.com")) return false;
    const p = u.pathname;
    const exp = normalizeSteamId64ForCache(expectedPartnerSteam64);

    if (p.includes("/tradeoffer/new/partnerinventory")) {
      const q = u.searchParams.get("partner")?.trim();
      if (!q) return false;
      return normalizeSteamId64ForCache(q) === exp;
    }

    const inv = p.match(/\/inventory\/([^/]+)\/730\/\d+/i);
    if (inv?.[1]) {
      return normalizeSteamId64ForCache(inv[1]) === exp;
    }

    const prof = p.match(/\/profiles\/([^/]+)\/inventory\/json\/730\//i);
    if (prof?.[1]) {
      return normalizeSteamId64ForCache(prof[1]) === exp;
    }

    // /id/<vanity>/… — нельзя сопоставить с partner без резолва vanity
    return false;
  } catch {
    return false;
  }
}

/** Только XHR trade-offer `partnerinventory` (не profile JSON). */
function isPartnerTradeOfferInventoryUrl(url: string, expectedPartnerSteam64: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith("steamcommunity.com")) return false;
    if (!u.pathname.includes("/tradeoffer/new/partnerinventory")) return false;
    const q = u.searchParams.get("partner")?.trim();
    if (!q) return false;
    return normalizeSteamId64ForCache(q) === normalizeSteamId64ForCache(expectedPartnerSteam64);
  } catch {
    return false;
  }
}

/**
 * CS2 partner inventory XHR on trade-offer page. Steam often sends `appid=730` first and may omit `contextid`
 * until after context selection — requiring both used to yield 0 XHR (unlock never counted).
 */
function partnerTradeOfferUrlIsCs2Context(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.searchParams.get("appid") !== String(TARGET_APPID)) return false;
    const ctx = u.searchParams.get("contextid");
    if (ctx == null || ctx === "") return true;
    return ctx === String(TARGET_CONTEXTID);
  } catch {
    return false;
  }
}

/** Только CS2: `partnerinventory?appid=730` или путь с сегментом `/730/`. */
function partnerInventoryUrlReferencesCs2(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.pathname.includes("/tradeoffer/new/partnerinventory")) {
      return u.searchParams.get("appid") === String(TARGET_APPID);
    }
    return u.pathname.includes(`/${TARGET_APPID}/`);
  } catch {
    return false;
  }
}

/**
 * Партнёр из URL (query или path) === ожидаемый steamId64 из trade URL, только CS2.
 * Все остальные XHR в merge не попадают.
 */
function isStrictPartnerCs2InventoryUrl(url: string, expectedPartnerSteam64: string): boolean {
  return isPartnerInventoryRequestUrl(url, expectedPartnerSteam64) && partnerInventoryUrlReferencesCs2(url);
}

function inventoryResponseHasMoreItems(body: Record<string, unknown>): boolean {
  if (body.more_items === true) return true;
  if (body.more === true) return true;
  if (body.more_start === true) return true;
  return false;
}

/** Ignore Steam error JSON; accept new `assets` or trade `rgInventory` (may be empty). */
function isUsableInventoryJson(data: Record<string, unknown>): boolean {
  if (data.success === false || data.success === 0) return false;
  if (Array.isArray(data.assets)) return true;
  if (data.rgInventory != null && typeof data.rgInventory === "object") return true;
  return false;
}

type PartnerWindowInv = { inv: unknown; source: string; declaredSteamId: string | null };

/** Только партнёр: UserThem, g_rgCurrentTradeStatus.them, g_rgPartnerInventory (не UserYou / g_rgAppContextData). */
async function tryReadPartnerInventoryFromTradeWindowGlobals(
  page: Page,
  expectedPartnerSteam64: string,
): Promise<unknown | null> {
  const expected = normalizeSteamId64ForCache(expectedPartnerSteam64);
  const res = await page
    .evaluate((exp: string) => {
      const OFF = "76561197960265728";
      function normSteam64(s: string): string {
        const t = s.trim();
        if (!/^\d+$/.test(t)) return t;
        try {
          const n = BigInt(t);
          const off = BigInt(OFF);
          return (n < off ? n + off : n).toString();
        } catch {
          return t;
        }
      }

      const pick = (raw: unknown): unknown | null => {
        if (!raw || typeof raw !== "object") return null;
        const o = raw as Record<string, unknown>;
        const inv = o.rgInventory;
        const desc = o.rgDescriptions;
        if (inv && desc && typeof inv === "object" && typeof desc === "object") {
          return {
            rgInventory: inv,
            rgDescriptions: desc,
            asset_properties: o.rgAssetProperties ?? o.asset_properties ?? [],
          };
        }
        return null;
      };

      function declaredId(obj: unknown): string | null {
        if (!obj || typeof obj !== "object") return null;
        const o = obj as Record<string, unknown>;
        const raw = o.steamid ?? o.strSteamId ?? o.m_steamId ?? o.m_ulSteamID ?? o.id;
        if (raw == null) return null;
        return normSteam64(String(raw));
      }

      const w = window as unknown as Record<string, unknown>;

      const tryPair = (obj: unknown, source: string): PartnerWindowInv | null => {
        const sid = declaredId(obj);
        if (sid != null && sid !== exp) return null;
        const inv = pick(obj);
        if (!inv) return null;
        return { inv, source, declaredSteamId: sid };
      };

      const tradeStatus = w.g_rgCurrentTradeStatus as Record<string, unknown> | undefined;
      const themFromStatus = tradeStatus?.them;

      const candidates: Array<[unknown, string]> = [
        [w.UserThem, "UserThem"],
        [themFromStatus, "g_rgCurrentTradeStatus.them"],
        [w.g_rgPartnerInventory, "g_rgPartnerInventory"],
      ];

      for (const [obj, label] of candidates) {
        const got = tryPair(obj, label);
        if (got) return got;
      }
      return null;
    }, expected)
    .catch(() => null);

  if (!res?.inv) return null;
  if (res.declaredSteamId != null && normalizeSteamId64ForCache(res.declaredSteamId) !== expected) {
    console.warn(LOG, "partner_window steamid mismatch", {
      source: res.source,
      declared: res.declaredSteamId,
      expected,
    });
    return null;
  }
  console.log(LOG, "inventory_from_partner_window", { source: res.source, declaredSteamId: res.declaredSteamId });
  return res.inv;
}

/**
 * Trade-offer page: ждём UI → выбор CS2 (730) + context 2 у партнёра → XHR partnerinventory,
 * затем пагинация и merge только партнёрских ответов (фильтр по SteamID из trade URL).
 */
async function runTradeOfferPuppeteerInventory(
  tradeUrl: string,
  options?: TradeOfferPuppeteerOptions,
): Promise<PuppeteerGuestInventoryResult> {
  const lp: TradeOfferPuppeteerLogProfile = options?.logProfile ?? "guest";
  const disabledReasonEarly = cookiesDisabledReason();
  if (disabledReasonEarly) {
    logTradeOfferPuppeteer(lp, "puppeteer_disabled_no_cookies", { reason: disabledReasonEarly });
    return { ok: false, reason: "disabled", detail: disabledReasonEarly };
  }

  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) {
    logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "invalid_trade_url" });
    return { ok: false, reason: "invalid_trade_url" };
  }

  const steamId64 = steamId64FromPartner(parsed.partner);
  const canonical =
    tradeUrl.trim().startsWith("http") ? tradeUrl.trim() : `https://${tradeUrl.trim()}`;

  const cookieHeader = process.env.STEAM_COMMUNITY_COOKIES!.trim();
  const cookiePairs = parseCookieHeader(cookieHeader);
  if (cookiePairs.length === 0) {
    logTradeOfferPuppeteer(lp, "puppeteer_disabled_no_cookies", {
      reason: "no_steam_community_cookies",
      detail: "no_cookie_pairs",
    });
    return { ok: false, reason: "disabled", detail: "no_cookie_pairs" };
  }

  if (lp === "owner") {
    const ownerEnv = process.env.OWNER_STEAM_ID?.trim();
    const fromCookie = trySteamId64FromSteamLoginSecureCookie(cookieHeader);
    const sessionMatchesOwner =
      fromCookie && ownerEnv
        ? normalizeSteamId64ForCache(fromCookie) === normalizeSteamId64ForCache(ownerEnv)
        : null;
    if (ownerEnv) {
      if (!fromCookie || sessionMatchesOwner === false) {
        const detail = !fromCookie
          ? "owner_cookie_missing_steam_login_secure"
          : "owner_cookie_session_mismatch";
        console.error(
          JSON.stringify({
            type: "owner_inv_puppeteer_error",
            event: "owner_cookie_session_invalid",
            detail,
            steamFromCookie: fromCookie ?? null,
            ownerSteamIdNorm: normalizeSteamId64ForCache(ownerEnv),
            partnerFromTradeUrl: steamId64,
            sessionMatchesOwner,
            ts: Date.now(),
          }),
        );
        logTradeOfferPuppeteer(lp, "owner_cookie_session_invalid", { detail, steamId64 });
        return { ok: false, reason: "disabled", detail };
      }
    }
  }

  let puppeteerMod: typeof import("puppeteer") | null = null;
  try {
    puppeteerMod = await import("puppeteer");
  } catch (e) {
    console.warn(LOG, "puppeteer import failed", e);
    logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "launch_failed", detail: "puppeteer_not_installed" });
    return { ok: false, reason: "launch_failed", detail: "puppeteer_not_installed" };
  }

  ensurePuppeteerCacheDir();
  const modNs = puppeteerMod as unknown as { default?: PuppeteerNode };
  const pp: PuppeteerNode = modNs.default ?? (puppeteerMod as unknown as PuppeteerNode);

  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (!executablePath && typeof pp.executablePath === "function") {
    try {
      executablePath = pp.executablePath();
    } catch (e) {
      console.warn(LOG, "executablePath() failed (run npm run build or npm run puppeteer:install)", e);
    }
  }
  if (executablePath) {
    console.log(LOG, "launch chrome", { executablePath, cacheDir: process.env.PUPPETEER_CACHE_DIR });
  } else {
    console.warn(LOG, "launch without explicit executablePath; set PUPPETEER_EXECUTABLE_PATH if launch fails");
  }

  if (executablePath && !existsSync(executablePath)) {
    logTradeOfferPuppeteer(lp,"puppeteer_chrome_missing", { executablePath, steamId64 });
    logTradeOfferPuppeteer(lp,"puppeteer_failed", {
      reason: "launch_failed",
      detail: "puppeteer_chrome_missing",
      steamId64,
    });
    return { ok: false, reason: "launch_failed", detail: "puppeteer_chrome_missing" };
  }

  if (lp === "owner") {
    const fromCookie = trySteamId64FromSteamLoginSecureCookie(cookieHeader);
    const ownerEnv = process.env.OWNER_STEAM_ID?.trim();
    logTradeOfferPuppeteer(lp, "owner_cookie_session_check", {
      steamFromCookie: fromCookie ?? null,
      ownerSteamIdNorm: ownerEnv ? normalizeSteamId64ForCache(ownerEnv) : null,
      partnerFromTradeUrl: steamId64,
      sessionMatchesOwner:
        fromCookie && ownerEnv
          ? normalizeSteamId64ForCache(fromCookie) === normalizeSteamId64ForCache(ownerEnv)
          : true,
    });
  }

  logTradeOfferPuppeteer(lp, lp === "owner" ? "puppeteer_owner_invoke" : "puppeteer_invoke", {
    steamId64,
    trade_url: canonical.length > 160 ? `${canonical.slice(0, 160)}…` : canonical,
  });

  let browser: Browser | null = null;
  const jsonChunks: unknown[] = [];
  /** At least one 200 JSON payload was appended from an inventory URL (may be empty `assets`). */
  let receivedInventoryJsonPayload = false;
  /** From the most recent inventory JSON body (`more_items` / pagination). */
  let lastResponseHadMoreItems = false;
  let lastInventoryJsonAt = 0;
  let saw403Inventory = false;
  let saw401Inventory = false;
  let saw429Inventory = false;

  /** Первый успешный `/tradeoffer/new/partnerinventory` с appid=730&contextid=2. */
  let partnerCs2TradeOfferXhrSeen = false;
  let partnerCs2TradeOfferMaxItems = 0;
  let partnerCs2EmptyGraceDeadline = 0;

  let partnerInventoryXhrCount = 0;
  let maxSingleXhrItems = 0;
  let hadPositivePartnerXhr = false;
  let usedWindowFallback = false;

  const deadline = Date.now() + MAX_BROWSER_MS;
  const timeLeft = () => deadline - Date.now();

  try {
    if (timeLeft() < 1500) {
      logPartnerInventorySummary(lp, {
        totalItems: 0,
        xhrCount: 0,
        maxItems: 0,
        hadPositiveItems: false,
        usedWindowFallback: false,
        steamId64,
        outcome: "failed",
      });
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "timeout", detail: "max_browser_time_precheck" });
      return { ok: false, reason: "timeout", detail: "max_browser_time" };
    }

    browser = await pp.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    await page.setCookie(
      ...cookiePairs.map((p) => ({
        name: p.name,
        value: p.value,
        domain: ".steamcommunity.com",
        path: "/",
      })),
    );

    const jsonBodyTasks: Promise<void>[] = [];

    page.on("response", (response) => {
      const url = response.url();
      if (!isStrictPartnerCs2InventoryUrl(url, steamId64)) return;
      try {
        if (url.includes("/tradeoffer/new/partnerinventory")) {
          const u = new URL(url);
          const pq = u.searchParams.get("partner")?.trim();
          if (!pq || normalizeSteamId64ForCache(pq) !== normalizeSteamId64ForCache(steamId64)) return;
        }
      } catch {
        return;
      }
      const status = response.status();
      if (status === 403) saw403Inventory = true;
      if (status === 401) saw401Inventory = true;
      if (status === 429) saw429Inventory = true;
      if (status !== 200) return;

      const task = (async () => {
        let text: string;
        try {
          text = await response.text();
        } catch {
          return;
        }
        const t = text.trim();
        if (!t.startsWith("{") && !t.startsWith("[")) return;
        let data: unknown;
        try {
          data = JSON.parse(t);
        } catch {
          return;
        }
        if (!data || typeof data !== "object") return;
        const o = data as Record<string, unknown>;
        if (!isUsableInventoryJson(o)) return;

        const pathShort = (() => {
          try {
            return new URL(url).pathname;
          } catch {
            return "";
          }
        })();
        const nItems = countItemsInInventoryJson(o);
        const isOfferCs2 =
          isPartnerTradeOfferInventoryUrl(url, steamId64) && partnerTradeOfferUrlIsCs2Context(url);

        if (isOfferCs2) {
          partnerCs2TradeOfferXhrSeen = true;
          if (nItems > partnerCs2TradeOfferMaxItems) partnerCs2TradeOfferMaxItems = nItems;
          if (nItems === 0) {
            partnerCs2EmptyGraceDeadline = Date.now() + PARTNER_CS2_EMPTY_SETTLE_MS;
          } else {
            partnerCs2EmptyGraceDeadline = 0;
          }
        }

        logTradeOfferPuppeteer(lp,"partner_inventory_xhr", {
          path: pathShort,
          items_count: nItems,
          partner_trade_offer_cs2: isOfferCs2,
          more_items: inventoryResponseHasMoreItems(o),
          steamId64,
        });

        partnerInventoryXhrCount += 1;
        maxSingleXhrItems = Math.max(maxSingleXhrItems, nItems);
        if (nItems > 0) hadPositivePartnerXhr = true;

        receivedInventoryJsonPayload = true;
        lastInventoryJsonAt = Date.now();
        jsonChunks.push(o);
        lastResponseHadMoreItems = inventoryResponseHasMoreItems(o);
      })();
      jsonBodyTasks.push(task);
    });

    const gotoMs = Math.min(GOTO_TIMEOUT_MS, Math.max(3000, timeLeft() - 500));
    await page.goto(canonical, { waitUntil: "domcontentloaded", timeout: gotoMs });
    lastInventoryJsonAt = Date.now();

    await waitForTradeUi(page, Math.min(TRADE_UI_WAIT_MS, Math.max(4000, timeLeft() - 3000)));
    logTradeOfferPuppeteer(lp,"trade_ui_ready", { steamId64 });

    const guardInitial = await detectTradeGuardOrConfirmation(page);
    if (guardInitial.likelyBlocked) {
      logTradeOfferPuppeteer(lp, "trade_guard_or_confirmation_hint", {
        steamId64,
        hints: guardInitial.hints,
        phase: "after_trade_ui",
      });
    }

    try {
      await page.click("#trade_theirs .trade_item_box, #trade_theirs").catch(() => {});
    } catch {
      /* optional */
    }

    const selectResult = await selectPartnerCs2Inventory(page);
    const selectionInvoked =
      selectResult.tradePageSelectInventoryCalled ||
      selectResult.jqueryTheirAppSelect ||
      selectResult.jqueryTheirContextSelect ||
      selectResult.loadInventoryFallback;
    const alreadyTarget =
      selectResult.beforeThemStatus != null &&
      Number(selectResult.beforeThemStatus.appid) === TARGET_APPID &&
      Number(selectResult.beforeThemStatus.contextid) === TARGET_CONTEXTID;
    const switched = selectionInvoked || !alreadyTarget;

    logTradeOfferPuppeteer(lp,"partner_inventory_context_selected", {
      appid: TARGET_APPID,
      contextid: TARGET_CONTEXTID,
      switched,
      already_target_context_before_select: alreadyTarget,
      tradePageSelectInventoryCalled: selectResult.tradePageSelectInventoryCalled,
      jqueryTheirAppSelect: selectResult.jqueryTheirAppSelect,
      jqueryTheirContextSelect: selectResult.jqueryTheirContextSelect,
      loadInventoryFallback: selectResult.loadInventoryFallback,
      beforeThemStatus: selectResult.beforeThemStatus,
      afterThemStatus: selectResult.afterThemStatus,
      errors: selectResult.errors.length ? selectResult.errors : undefined,
      steamId64,
    });

    await sleepMs(250);
    await selectPartnerCs2Inventory(page);

    const waitPartnerCs2Unlock = async (retryLabel: string) => {
      let xhrWaitAccumLocal = 0;
      for (let unlockAttempt = 1; unlockAttempt <= 2; unlockAttempt++) {
        if (unlockAttempt === 2) {
          logTradeOfferPuppeteer(lp, "partner_inventory_context_retry", {
            steamId64,
            unlockAttempt: 2,
            retry_label: retryLabel,
          });
          await selectPartnerCs2Inventory(page);
        }
        const xhrWaitStart = Date.now();
        const xhrDeadline = Math.min(Date.now() + PARTNER_CS2_XHR_WAIT_MS, deadline - 800);
        while (Date.now() < xhrDeadline && timeLeft() > 400) {
          await Promise.allSettled(jsonBodyTasks);
          if (partnerCs2TradeOfferXhrSeen) {
            if (partnerCs2TradeOfferMaxItems > 0) break;
            if (partnerCs2EmptyGraceDeadline > 0 && Date.now() >= partnerCs2EmptyGraceDeadline) break;
          }
          await sleepMs(200);
        }
        xhrWaitAccumLocal += Date.now() - xhrWaitStart;
        if (partnerCs2TradeOfferXhrSeen) break;
      }
      return xhrWaitAccumLocal;
    };

    let xhrWaitAccum = await waitPartnerCs2Unlock("primary");

    if (!partnerCs2TradeOfferXhrSeen && timeLeft() > 8000) {
      logTradeOfferPuppeteer(lp, "partner_inventory_page_reload_retry", { steamId64 });
      jsonChunks.length = 0;
      receivedInventoryJsonPayload = false;
      lastResponseHadMoreItems = false;
      partnerCs2TradeOfferXhrSeen = false;
      partnerCs2TradeOfferMaxItems = 0;
      partnerCs2EmptyGraceDeadline = 0;
      partnerInventoryXhrCount = 0;
      maxSingleXhrItems = 0;
      hadPositivePartnerXhr = false;
      usedWindowFallback = false;
      lastInventoryJsonAt = Date.now();

      const reloadTo = Math.min(GOTO_TIMEOUT_MS, Math.max(5000, timeLeft() - 2500));
      await page.reload({ waitUntil: "domcontentloaded", timeout: reloadTo }).catch((e) => {
        console.warn(LOG, "page.reload failed", e);
      });
      await waitForTradeUi(page, Math.min(TRADE_UI_WAIT_MS, Math.max(4000, timeLeft() - 4000)));
      const guardReload = await detectTradeGuardOrConfirmation(page);
      if (guardReload.likelyBlocked) {
        logTradeOfferPuppeteer(lp, "trade_guard_or_confirmation_hint", {
          steamId64,
          hints: guardReload.hints,
          phase: "after_reload",
        });
      }
      await page.click("#trade_theirs .trade_item_box, #trade_theirs").catch(() => {});
      await selectPartnerCs2Inventory(page);
      await sleepMs(350);
      await selectPartnerCs2Inventory(page);
      xhrWaitAccum += await waitPartnerCs2Unlock("after_reload");
    }

    logTradeOfferPuppeteer(lp,"partner_inventory_xhr_wait_done", {
      waited_ms: xhrWaitAccum,
      partner_cs2_xhr_seen: partnerCs2TradeOfferXhrSeen,
      max_items_from_partner_cs2_xhr: partnerCs2TradeOfferMaxItems,
      got_positive_items: partnerCs2TradeOfferMaxItems > 0,
      steamId64,
    });

    if (!partnerCs2TradeOfferXhrSeen) {
      const mergedTimeout = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
      const nTimeout = mergedTimeout.assets?.length ?? 0;
      logPartnerInventorySummary(lp, {
        totalItems: nTimeout,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "failed",
      });
      logTradeOfferPuppeteer(lp,"puppeteer_failed", {
        reason: "timeout",
        detail: "partnerinventory_cs2_xhr",
        steamId64,
      });
      return { ok: false, reason: "timeout", detail: "partnerinventory_cs2_xhr" };
    }

    while (timeLeft() > 350) {
      await Promise.allSettled(jsonBodyTasks);

      const mergedBefore = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
      const nBefore = mergedBefore.assets?.length ?? 0;

      const fromWindow = await tryReadPartnerInventoryFromTradeWindowGlobals(page, steamId64);
      if (fromWindow && typeof fromWindow === "object" && isUsableInventoryJson(fromWindow as Record<string, unknown>)) {
        const mergedTrial = mergeCommunityInventoryJson([...jsonChunks, fromWindow]) as { assets?: unknown[] };
        const nTrial = mergedTrial.assets?.length ?? 0;
        if (nTrial > nBefore) {
          usedWindowFallback = true;
          jsonChunks.push(fromWindow as Record<string, unknown>);
          receivedInventoryJsonPayload = true;
          lastInventoryJsonAt = Date.now();
          lastResponseHadMoreItems = inventoryResponseHasMoreItems(fromWindow as Record<string, unknown>);
          console.log(LOG, "inventory_from_window_globals", { nTrial });
        }
      }

      const idle = lastInventoryJsonAt > 0 ? Date.now() - lastInventoryJsonAt : 0;
      const mergedTry = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
      const n = mergedTry.assets?.length ?? 0;

      const cs2UnlockHadPositiveItems = partnerCs2TradeOfferMaxItems > 0;
      const idleThreshold =
        !lastResponseHadMoreItems && cs2UnlockHadPositiveItems
          ? INVENTORY_JSON_IDLE_AFTER_POSITIVE_MS
          : INVENTORY_JSON_IDLE_MS;

      if (receivedInventoryJsonPayload) {
        if (!lastResponseHadMoreItems && idle >= idleThreshold) {
          console.log(LOG, "ok assets=", n, "steamId64=", steamId64, "more_items=false idle=", idle);
          logPartnerInventorySummary(lp, {
            totalItems: n,
            xhrCount: partnerInventoryXhrCount,
            maxItems: maxSingleXhrItems,
            hadPositiveItems: hadPositivePartnerXhr,
            usedWindowFallback,
            steamId64,
            outcome: "success",
          });
          logTradeOfferPuppeteer(lp,"puppeteer_success", { items_count: n, steamId64, more_items: false });
          return { ok: true, raw: mergedTry, steamId64, source: "trade_url" };
        }
        if (lastResponseHadMoreItems && idle >= INVENTORY_JSON_STALL_WHILE_MORE_MS && n > 0) {
          console.log(
            LOG,
            "ok partial pagination stall assets=",
            n,
            "steamId64=",
            steamId64,
            "idle=",
            idle,
          );
          logPartnerInventorySummary(lp, {
            totalItems: n,
            xhrCount: partnerInventoryXhrCount,
            maxItems: maxSingleXhrItems,
            hadPositiveItems: hadPositivePartnerXhr,
            usedWindowFallback,
            steamId64,
            outcome: "success",
          });
          logTradeOfferPuppeteer(lp,"puppeteer_success", { items_count: n, steamId64, more_items: true, partial: true });
          return { ok: true, raw: mergedTry, steamId64, source: "trade_url" };
        }
      }

      await sleepMs(280);
    }

    if (timeLeft() <= 0) {
      const mergedT = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
      const nT = mergedT.assets?.length ?? 0;
      logPartnerInventorySummary(lp, {
        totalItems: nT,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "failed",
      });
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "timeout", detail: "max_browser_time", steamId64 });
      return { ok: false, reason: "timeout", detail: "max_browser_time" };
    }

    await sleepMs(400);

    const mergedEarly = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
    if (
      receivedInventoryJsonPayload &&
      !saw403Inventory &&
      !saw401Inventory &&
      !saw429Inventory &&
      (!mergedEarly.assets || mergedEarly.assets.length === 0)
    ) {
      const nEmpty = mergedEarly.assets?.length ?? 0;
      logPartnerInventorySummary(lp, {
        totalItems: nEmpty,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "success",
      });
      logTradeOfferPuppeteer(lp,"puppeteer_success", {
        items_count: nEmpty,
        steamId64,
        note: "empty_after_unlock",
        only_zero_xhr: !hadPositivePartnerXhr,
      });
      return { ok: true, raw: mergedEarly, steamId64, source: "trade_url" };
    }

    const pageText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const dom = await classifyDom(page);
    const textClass = classifyPageText(pageText);

    const merged = mergeCommunityInventoryJson(jsonChunks);
    const obj = merged as { assets?: unknown[] };
    if (obj.assets && obj.assets.length > 0) {
      logPartnerInventorySummary(lp, {
        totalItems: obj.assets.length,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "success",
      });
      logTradeOfferPuppeteer(lp,"puppeteer_success", { items_count: obj.assets.length, steamId64 });
      return { ok: true, raw: merged, steamId64, source: "trade_url" };
    }
    if (receivedInventoryJsonPayload && !saw403Inventory && !saw401Inventory && !saw429Inventory) {
      const nRem = obj.assets?.length ?? 0;
      logPartnerInventorySummary(lp, {
        totalItems: nRem,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "success",
      });
      logTradeOfferPuppeteer(lp,"puppeteer_success", { items_count: nRem, steamId64 });
      return { ok: true, raw: merged, steamId64, source: "trade_url" };
    }

    const mergedFail = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
    const nFail = mergedFail.assets?.length ?? 0;
    const failSummary = () =>
      logPartnerInventorySummary(lp, {
        totalItems: nFail,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "failed",
      });

    if (dom.tradeBlocked || textClass === "cannot_trade") {
      failSummary();
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "cannot_trade", steamId64 });
      return { ok: false, reason: "cannot_trade" };
    }
    if (saw403Inventory || saw401Inventory || dom.profilePrivate || textClass === "private") {
      failSummary();
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "private", steamId64 });
      return { ok: false, reason: "private" };
    }
    if (saw429Inventory) {
      failSummary();
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "rate_limited", detail: "inventory_http_429", steamId64 });
      return { ok: false, reason: "rate_limited", detail: "inventory_http_429" };
    }
    if (dom.inventoryUnavailable || textClass === "not_available") {
      failSummary();
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "not_available", steamId64 });
      return { ok: false, reason: "not_available" };
    }
    failSummary();
    logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "empty", steamId64 });
    return { ok: false, reason: "empty" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      const mergedCatch = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
      const nCatch = mergedCatch.assets?.length ?? 0;
      logPartnerInventorySummary(lp, {
        totalItems: nCatch,
        xhrCount: partnerInventoryXhrCount,
        maxItems: maxSingleXhrItems,
        hadPositiveItems: hadPositivePartnerXhr,
        usedWindowFallback,
        steamId64,
        outcome: "failed",
      });
    } catch {
      /* ignore */
    }
    if (msg.includes("timeout") || msg.includes("Timeout") || timeLeft() <= 0) {
      logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "timeout", detail: msg, steamId64 });
      return { ok: false, reason: "timeout", detail: msg };
    }
    console.error(LOG, "error", e);
    logTradeOfferPuppeteer(lp,"puppeteer_failed", { reason: "unknown", detail: msg, steamId64 });
    return { ok: false, reason: "unknown", detail: msg };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function fetchGuestInventoryViaTradeOfferPuppeteer(
  tradeUrl: string,
  options?: TradeOfferPuppeteerOptions,
): Promise<PuppeteerGuestInventoryResult> {
  const lp: TradeOfferPuppeteerLogProfile = options?.logProfile ?? "guest";
  const result = await runTradeOfferPuppeteerInventory(tradeUrl, options);
  recordTradeOfferPuppeteerOutcome(lp, result.ok);
  return result;
}
