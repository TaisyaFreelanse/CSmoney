import "server-only";

import type { Browser, Page } from "puppeteer";

import { parseTradeUrl, steamId64FromPartner } from "@/lib/steam-inventory";

const LOG = "[guest-inv-puppeteer]";
/** Large inventories need several paginated XHRs; allow time for them + gate spacing. */
const MAX_BROWSER_MS = 28_000;
const GOTO_TIMEOUT_MS = 12_000;
/** After last inventory JSON, wait this long before treating pagination as finished. */
const INVENTORY_JSON_IDLE_MS = 1100;
/** If `more_items` stays true but no new JSON arrives, stop and let API merge complete the list. */
const INVENTORY_JSON_STALL_WHILE_MORE_MS = 2800;

export type PuppeteerGuestInventoryResult =
  | { ok: true; raw: unknown; steamId64: string }
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

function cookiesEnabled(): boolean {
  const v = process.env.STEAM_COMMUNITY_COOKIES?.trim();
  if (!v) return false;
  if (process.env.STEAM_INVENTORY_BROWSER === "0") return false;
  return true;
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

function mergeCommunityInventoryJson(chunks: unknown[]): unknown {
  const allAssets: unknown[] = [];
  const allAssetProps: unknown[] = [];
  const descMap = new Map<string, unknown>();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const j = chunk as Record<string, unknown>;
    if (Array.isArray(j.assets)) allAssets.push(...j.assets);
    if (Array.isArray(j.asset_properties)) allAssetProps.push(...j.asset_properties);
    if (Array.isArray(j.descriptions)) {
      for (const d of j.descriptions) {
        const row = d as Record<string, unknown>;
        const key = `${row.classid}_${row.instanceid}`;
        if (!descMap.has(key)) descMap.set(key, d);
      }
    }
  }
  return {
    assets: allAssets,
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

function isInventoryJsonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("steamcommunity.com")) return false;
    return /\/inventory\/\d+\/730\/\d/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Trade-offer page + inventory JSON via network (single session cookies).
 * Hard-capped at MAX_BROWSER_MS wall time (launch + navigation + JSON poll).
 */
export async function fetchGuestInventoryViaTradeOfferPuppeteer(tradeUrl: string): Promise<PuppeteerGuestInventoryResult> {
  if (!cookiesEnabled()) {
    return { ok: false, reason: "disabled" };
  }

  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) return { ok: false, reason: "invalid_trade_url" };

  const steamId64 = steamId64FromPartner(parsed.partner);

  let puppeteer: typeof import("puppeteer") | null = null;
  try {
    puppeteer = await import("puppeteer");
  } catch (e) {
    console.warn(LOG, "puppeteer import failed", e);
    return { ok: false, reason: "launch_failed", detail: "puppeteer_not_installed" };
  }

  const cookieHeader = process.env.STEAM_COMMUNITY_COOKIES!.trim();
  const cookiePairs = parseCookieHeader(cookieHeader);
  if (cookiePairs.length === 0) {
    return { ok: false, reason: "disabled", detail: "no_cookie_pairs" };
  }

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

  const deadline = Date.now() + MAX_BROWSER_MS;
  const timeLeft = () => deadline - Date.now();

  try {
    if (timeLeft() < 1500) {
      return { ok: false, reason: "timeout", detail: "max_browser_time" };
    }

    browser = await puppeteer.launch({
      headless: true,
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

    page.on("response", (response) => {
      const url = response.url();
      if (!isInventoryJsonUrl(url)) return;
      const status = response.status();
      if (status === 403) saw403Inventory = true;
      if (status === 401) saw401Inventory = true;
      if (status === 429) saw429Inventory = true;
      if (status !== 200) return;
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("application/json") && !ct.includes("text/json")) return;
      void response
        .json()
        .then((data) => {
          if (data && typeof data === "object") {
            receivedInventoryJsonPayload = true;
            lastInventoryJsonAt = Date.now();
            jsonChunks.push(data);
            const o = data as Record<string, unknown>;
            lastResponseHadMoreItems = o.more_items === true;
          }
        })
        .catch(() => {});
    });

    const canonical =
      tradeUrl.trim().startsWith("http") ? tradeUrl.trim() : `https://${tradeUrl.trim()}`;

    const gotoMs = Math.min(GOTO_TIMEOUT_MS, Math.max(3000, timeLeft() - 500));
    await page.goto(canonical, { waitUntil: "domcontentloaded", timeout: gotoMs });
    lastInventoryJsonAt = Date.now();

    while (timeLeft() > 350) {
      const idle = lastInventoryJsonAt > 0 ? Date.now() - lastInventoryJsonAt : 0;
      const mergedTry = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
      const n = mergedTry.assets?.length ?? 0;

      if (receivedInventoryJsonPayload) {
        if (!lastResponseHadMoreItems && idle >= INVENTORY_JSON_IDLE_MS) {
          console.log(LOG, "ok assets=", n, "steamId64=", steamId64, "more_items=false idle=", idle);
          return { ok: true, raw: mergedTry, steamId64 };
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
          return { ok: true, raw: mergedTry, steamId64 };
        }
      }

      await new Promise((r) => setTimeout(r, 280));
    }

    if (timeLeft() <= 0) {
      return { ok: false, reason: "timeout", detail: "max_browser_time" };
    }

    await new Promise((r) => setTimeout(r, 400));

    const mergedEarly = mergeCommunityInventoryJson(jsonChunks) as { assets?: unknown[] };
    if (
      receivedInventoryJsonPayload &&
      !saw403Inventory &&
      !saw401Inventory &&
      !saw429Inventory &&
      (!mergedEarly.assets || mergedEarly.assets.length === 0)
    ) {
      return { ok: true, raw: mergedEarly, steamId64 };
    }

    const pageText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const dom = await classifyDom(page);
    const textClass = classifyPageText(pageText);

    const merged = mergeCommunityInventoryJson(jsonChunks);
    const obj = merged as { assets?: unknown[] };
    if (obj.assets && obj.assets.length > 0) {
      return { ok: true, raw: merged, steamId64 };
    }
    if (receivedInventoryJsonPayload && !saw403Inventory && !saw401Inventory && !saw429Inventory) {
      return { ok: true, raw: merged, steamId64 };
    }

    if (dom.tradeBlocked || textClass === "cannot_trade") {
      return { ok: false, reason: "cannot_trade" };
    }
    if (saw403Inventory || saw401Inventory || dom.profilePrivate || textClass === "private") {
      return { ok: false, reason: "private" };
    }
    if (saw429Inventory) {
      return { ok: false, reason: "rate_limited", detail: "inventory_http_429" };
    }
    if (dom.inventoryUnavailable || textClass === "not_available") {
      return { ok: false, reason: "not_available" };
    }
    return { ok: false, reason: "empty" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timeout") || msg.includes("Timeout") || timeLeft() <= 0) {
      return { ok: false, reason: "timeout", detail: msg };
    }
    console.error(LOG, "error", e);
    return { ok: false, reason: "unknown", detail: msg };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
