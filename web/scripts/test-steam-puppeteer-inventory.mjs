/**
 * Локальная проверка: инвентарь партнёра на trade-offer.
 *
 * После загрузки страницы явно выбирается CS2 (730) + context 2 для UserThem,
 * иначе Steam часто не шлёт partnerinventory XHR.
 *
 * Запуск: cd web && npm run test:puppeteer-steam
 * Headless: STEAM_TEST_HEADLESS=1 npm run test:puppeteer-steam
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

const STEAM64_OFFSET = BigInt("76561197960265728");
const TARGET_APPID = 730;
const TARGET_CONTEXTID = 2;
const PARTNER_XHR_WAIT_MS = 45_000;
const TRADE_UI_WAIT_MS = 60_000;

const TRADE_URL =
  process.env.STEAM_TEST_TRADE_URL ??
  "https://steamcommunity.com/tradeoffer/new/?partner=351815157&token=MPDBjSrY";

const COOKIE_HEADER_EMBEDDED = `sessionid=ceb9afec6d562470f4fb4049; steamLoginSecure=76561199046808399%7C%7CeyAidHlwIjogIkpXVCIsICJhbGciOiAiRWREU0EiIH0.eyAiaXNzIjogInI6MDAwMV8yODAwNzZBN18yQTBGMiIsICJzdWIiOiAiNzY1NjExOTkwNDY4MDgzOTkiLCAiYXVkIjogWyAid2ViOmNvbW11bml0eSIgXSwgImV4cCI6IDE3NzU5MjM3NzgsICJuYmYiOiAxNzY3MTk1OTAzLCAiaWF0IjogMTc3NTgzNTkwMywgImp0aSI6ICIwMDE2XzI4MDA3NkQ4XzA4MzM2IiwgIm9hdCI6IDE3NzU4MzU5MDMsICJydF9leHAiOiAxNzk0MDY2MTAxLCAicGVyIjogMCwgImlwX3N1YmplY3QiOiAiMzEuMTI5LjE4NS40MSIsICJpcF9jb25maXJtZXIiOiAiMzEuMTI5LjE4NS40MSIgfQ.0aKh_b6k0XVdNZPkXhni5YexFclGKm5MN9Ag1_kMLbbkiF9JY0bP58PnEwwOJumnsL1-v6uGHSntf6XxJH6rBg; steamCountry=UA%7Cde0abee37c9f7565b79f6e3512bfa8a1; browserid=134685881449885122;`;

const COOKIE_HEADER = (process.env.STEAM_TEST_COOKIE_HEADER ?? COOKIE_HEADER_EMBEDDED).trim();

const HEADLESS = process.env.STEAM_TEST_HEADLESS === "1" || process.env.STEAM_TEST_HEADLESS === "true";

function parseTradePartner(tradeUrl) {
  try {
    const u = new URL(tradeUrl.trim().startsWith("http") ? tradeUrl.trim() : `https://${tradeUrl.trim()}`);
    const p = u.searchParams.get("partner")?.trim();
    if (!p || !/^\d+$/.test(p)) return null;
    return p;
  } catch {
    return null;
  }
}

function normalizeSteamId64ForCache(raw) {
  const t = String(raw).trim();
  if (!/^\d+$/.test(t)) return t;
  try {
    const n = BigInt(t);
    if (n < STEAM64_OFFSET) return (n + STEAM64_OFFSET).toString();
    return t;
  } catch {
    return t;
  }
}

function steamId64FromPartner(partner) {
  return (BigInt(partner) + STEAM64_OFFSET).toString();
}

function parseCookieHeader(header) {
  const out = [];
  for (const part of header.split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const name = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

function countItemsFromJson(data) {
  if (!data || typeof data !== "object") return 0;
  const o = data;
  if (o.rgInventory && typeof o.rgInventory === "object") {
    return Object.keys(o.rgInventory).length;
  }
  if (Array.isArray(o.assets)) {
    return o.assets.length;
  }
  return 0;
}

function isPartnerInventoryUrl(url, expectedPartnerSteam64) {
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
    if (inv?.[1]) return normalizeSteamId64ForCache(inv[1]) === exp;

    const prof = p.match(/\/profiles\/([^/]+)\/inventory\/json\/730\//i);
    if (prof?.[1]) return normalizeSteamId64ForCache(prof[1]) === exp;

    return false;
  } catch {
    return false;
  }
}

function log(event, payload = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...payload }));
}

async function readPartnerFromWindow(page, expectedSteam64) {
  const exp = normalizeSteamId64ForCache(expectedSteam64);
  return page
    .evaluate((expStr) => {
      const OFF = "76561197960265728";
      function norm(s) {
        const t = String(s).trim();
        if (!/^\d+$/.test(t)) return t;
        try {
          const n = BigInt(t);
          const off = BigInt(OFF);
          return (n < off ? n + off : n).toString();
        } catch {
          return t;
        }
      }
      function pick(raw) {
        if (!raw || typeof raw !== "object") return null;
        const inv = raw.rgInventory;
        const desc = raw.rgDescriptions;
        if (inv && desc && typeof inv === "object" && typeof desc === "object") {
          return {
            rgInventory: inv,
            rgDescriptions: desc,
            asset_properties: raw.rgAssetProperties ?? raw.asset_properties ?? [],
          };
        }
        return null;
      }
      function sidOf(obj) {
        if (!obj || typeof obj !== "object") return null;
        const raw = obj.steamid ?? obj.strSteamId ?? obj.m_steamId ?? obj.m_ulSteamID ?? obj.id;
        return raw != null ? norm(String(raw)) : null;
      }
      const w = window;
      const tradeStatus = w.g_rgCurrentTradeStatus;
      const candidates = [
        [w.UserThem, "UserThem"],
        [tradeStatus?.them, "g_rgCurrentTradeStatus.them"],
        [w.g_rgPartnerInventory, "g_rgPartnerInventory"],
      ];
      for (const [obj, label] of candidates) {
        if (!obj || typeof obj !== "object") continue;
        const sid = sidOf(obj);
        if (sid != null && sid !== expStr) continue;
        const inv = pick(obj);
        if (inv) {
          return { inv, source: label, declaredSteamId: sid };
        }
      }
      return null;
    }, exp)
    .catch(() => null);
}

/**
 * Ждём trade UI и явно выбираем инвентарь партнёра CS2 (730) / context 2.
 * См. Steam economy_trade.js: TradePageSelectInventory(UserThem, appid, contextid)
 */
async function selectPartnerCs2Inventory(page) {
  return page.evaluate((appid, ctxid) => {
    const w = window;
    const $J = w.$J || w.jQuery;
    const out = {
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
  }, TARGET_APPID, TARGET_CONTEXTID);
}

async function waitForTradeUi(page) {
  await page.waitForFunction(
    () =>
      typeof window.TradePageSelectInventory === "function" &&
      window.UserThem != null &&
      (document.querySelector("#inventories") != null ||
        document.querySelector(".trade_content") != null ||
        document.querySelector("#tradeoffer_items") != null),
    { timeout: TRADE_UI_WAIT_MS, polling: 400 },
  );
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const partnerRaw = parseTradePartner(TRADE_URL);
  if (!partnerRaw) {
    console.error("TRADE_URL: нет параметра partner");
    process.exit(1);
  }
  const expectedPartnerSteam64 = steamId64FromPartner(partnerRaw);

  log("puppeteer_start", {
    tradeUrl: TRADE_URL,
    partnerQuery: partnerRaw,
    expectedPartnerSteam64,
    headless: HEADLESS,
  });

  if (!process.env.PUPPETEER_CACHE_DIR?.trim()) {
    process.env.PUPPETEER_CACHE_DIR = path.join(webRoot, ".puppeteer-chrome");
  }

  const puppeteer = (await import("puppeteer")).default;
  let executablePath;
  try {
    executablePath = puppeteer.executablePath();
  } catch {
    /* optional */
  }

  const pairs = parseCookieHeader(COOKIE_HEADER);
  if (pairs.length === 0) {
    console.error("No cookies parsed.");
    process.exit(1);
  }

  log("cookies_applied", { count: pairs.length, names: pairs.map((p) => p.name) });

  let partnerXhrCount = 0;
  let maxPartnerItems = 0;
  const seenPaths = [];
  /** @type {Array<{ url: string; partnerParamOk: boolean }>} */
  const xhrLog = [];

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    await page.setCookie(
      ...pairs.map((p) => ({
        name: p.name,
        value: p.value,
        domain: ".steamcommunity.com",
        path: "/",
      })),
    );

    page.on("response", async (response) => {
      const url = response.url();
      if (!isPartnerInventoryUrl(url, expectedPartnerSteam64)) return;
      if (response.status() !== 200) return;

      let text;
      try {
        text = await response.text();
      } catch {
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }

      if (!data || typeof data !== "object") return;
      if (data.success === false || data.success === 0) return;

      let urlPartnerNorm = null;
      try {
        const q = new URL(url).searchParams.get("partner")?.trim();
        if (q) urlPartnerNorm = normalizeSteamId64ForCache(q);
      } catch {
        /* ignore */
      }
      const partnerParamOk = urlPartnerNorm == null || urlPartnerNorm === expectedPartnerSteam64;

      partnerXhrCount += 1;
      const n = countItemsFromJson(data);
      if (n > maxPartnerItems) maxPartnerItems = n;
      const shortPath = url.split("?")[0].replace(/^https:\/\/[^/]+/, "");
      seenPaths.push(shortPath);

      xhrLog.push({ url: url.length > 200 ? `${url.slice(0, 200)}…` : url, partnerParamOk });

      log("partner_inventory_xhr", {
        path: shortPath,
        items_count: n,
        url_partner_matches_expected: partnerParamOk,
        expectedPartnerSteam64,
      });
    });

    const gotoUrl = TRADE_URL.trim().startsWith("http") ? TRADE_URL.trim() : `https://${TRADE_URL.trim()}`;

    await page.goto(gotoUrl, { waitUntil: "networkidle2", timeout: 120_000 });
    log("page_loaded", { url: page.url() });

    await waitForTradeUi(page);
    log("trade_ui_ready", {});

    try {
      await page.click("#trade_theirs .trade_item_box, #trade_theirs").catch(() => {});
    } catch {
      /* optional: focus partner column */
    }

    const beforeSelect = { maxItems: maxPartnerItems, xhrCount: partnerXhrCount };

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

    /** Было ли переключение: явный вызов выбора ИЛИ до выбора не стояло 730/2 */
    const switched = selectionInvoked || !alreadyTarget;

    log("partner_inventory_context_selected", {
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
    });

    const waitStart = Date.now();
    while (Date.now() - waitStart < PARTNER_XHR_WAIT_MS) {
      if (maxPartnerItems > 0) break;
      await sleep(250);
    }

    log("partner_inventory_xhr_wait_done", {
      waited_ms: Date.now() - waitStart,
      max_items_from_partner_xhr: maxPartnerItems,
      got_positive_items: maxPartnerItems > 0,
    });

    await sleep(800);

    const fromWin = await readPartnerFromWindow(page, expectedPartnerSteam64);
    let windowItems = 0;
    if (fromWin?.inv) {
      windowItems = countItemsFromJson(fromWin.inv);
      log("partner_window_inventory", {
        source: fromWin.source,
        declaredSteamId: fromWin.declaredSteamId,
        items_count: windowItems,
        expectedPartnerSteam64,
      });
    } else {
      log("partner_window_inventory", { found: false, expectedPartnerSteam64 });
    }

    const maxItems = Math.max(maxPartnerItems, windowItems);

    log("inventory_summary", {
      partner_xhr_count: partnerXhrCount,
      max_items_from_partner_xhr: maxPartnerItems,
      xhr_delta_after_context_select: {
        xhrCount: partnerXhrCount - beforeSelect.xhrCount,
        maxItems: maxPartnerItems - beforeSelect.maxItems,
      },
      max_items_from_window: windowItems,
      max_items_total: maxItems,
      distinct_xhr_paths: [...new Set(seenPaths)],
      xhr_partner_checks: xhrLog,
    });

    let outcome;
    if (partnerXhrCount === 0 && windowItems === 0) {
      outcome = "inventory_not_loaded";
    } else if (maxItems === 0) {
      outcome = "inventory_empty";
    } else {
      outcome = "SUCCESS";
    }

    log("final_result", { outcome, partnerXhrCount, windowItems, maxItems });

    console.log("\n---");
    console.log(outcome);
    console.log("---\n");
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
