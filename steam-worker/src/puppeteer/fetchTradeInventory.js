import fs from "node:fs";
import {
  mergeCommunityInventoryJson,
  isUsableInventoryJson,
  inventoryHasMoreItems,
} from "../utils/inventoryMerge.js";
import { normalizeSteamId64 } from "../utils/steamUrl.js";
import { logJson } from "../utils/logger.js";
import { runWithTimeout } from "../utils/runWithTimeout.js";
import {
  authenticatePuppeteerProxy,
  puppeteerChromeArgs,
  puppeteerHeadless,
} from "../utils/puppeteerProxy.js";

const TARGET_APPID = 730;
const TARGET_CONTEXTID = 2;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStrictPartnerCs2(url, expectedSteam64) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith("steamcommunity.com")) return false;
    if (!u.pathname.includes("/tradeoffer/new/partnerinventory")) return false;
    if (u.searchParams.get("appid") !== String(TARGET_APPID)) return false;
    const q = u.searchParams.get("partner")?.trim();
    if (!q) return false;
    return normalizeSteamId64(q) === normalizeSteamId64(expectedSteam64);
  } catch {
    return false;
  }
}

async function waitForTradeUi(page, timeoutMs) {
  await page.waitForFunction(
    () =>
      typeof window.TradePageSelectInventory === "function" &&
      window.UserThem != null &&
      (document.querySelector("#inventories") != null ||
        document.querySelector(".trade_content") != null ||
        document.querySelector("#tradeoffer_items") != null),
    { timeout: Math.max(3000, timeoutMs), polling: 400 },
  );
}

async function evaluateSteamSessionState(page) {
  return page
    .evaluate(() => {
      const href = window.location.href.toLowerCase();
      const loginUrl =
        href.includes("/login") &&
        (href.includes("steamcommunity") || href.includes("steampowered") || href.includes("steam"));
      const loginForm =
        document.querySelector("#loginForm") != null ||
        document.querySelector("form[action*='Login']") != null ||
        document.querySelector("form[action*='login']") != null ||
        document.querySelector(".newlogindialog_ModalContainer") != null;
      const tradeSurface =
        typeof window.TradePageSelectInventory === "function" ||
        document.querySelector("#inventories") != null ||
        document.querySelector(".trade_content") != null ||
        document.querySelector("#tradeoffer_items") != null;
      const loginWall = (loginUrl || loginForm) && !tradeSurface;
      return {
        loginWall,
        tradeSurfacePresent: tradeSurface,
        pageUrl: window.location.href,
      };
    })
    .catch(() => ({ loginWall: false, tradeSurfacePresent: false, pageUrl: "" }));
}

async function selectPartnerCs2Inventory(page) {
  return page.evaluate(
    (appid, ctxid) => {
      const w = window;
      const out = {
        tradePageSelectInventoryCalled: false,
        jqueryTheirAppSelect: false,
        jqueryTheirContextSelect: false,
        loadInventoryFallback: false,
        errors: [],
      };
      try {
        if (typeof w.TradePageSelectInventory === "function" && w.UserThem) {
          w.TradePageSelectInventory(w.UserThem, appid, ctxid);
          out.tradePageSelectInventoryCalled = true;
          try {
            w.TradePageSelectInventory(w.UserThem, appid, ctxid);
          } catch {
            /* nudge */
          }
        }
      } catch (e) {
        out.errors.push(String(e));
      }
      if (!out.tradePageSelectInventoryCalled) {
        try {
          const $J = w.$J ?? w.jQuery;
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
          out.errors.push(String(e));
        }
      }
      return out;
    },
    TARGET_APPID,
    TARGET_CONTEXTID,
  );
}

function mergedToItems(merged) {
  const descByKey = new Map();
  for (const d of merged.descriptions ?? []) {
    if (!d || typeof d !== "object") continue;
    const k = `${d.classid}_${d.instanceid ?? "0"}`;
    if (!descByKey.has(k)) descByKey.set(k, d);
  }
  const items = [];
  for (const a of merged.assets ?? []) {
    if (!a || typeof a !== "object") continue;
    const cid = String(a.classid ?? "");
    const iid = String(a.instanceid ?? "0");
    const dk = `${cid}_${iid}`;
    const desc = descByKey.get(dk) ?? descByKey.get(`${cid}_0`);
    items.push({
      assetid: String(a.assetid ?? a.id ?? ""),
      classid: cid,
      instanceid: iid,
      amount: a.amount != null ? Number(a.amount) : 1,
      market_hash_name: desc?.market_hash_name ?? null,
      name: desc?.name ?? null,
    });
  }
  return items;
}

/**
 * @param {object} opts
 */
export async function fetchTradeInventory(opts) {
  const {
    tradeUrlCanonical,
    partnerSteamId64,
    userDataDir,
    accountId,
    partnerXhrWaitMs: partnerXhrWaitMsOpt,
  } = opts;

  const taskTimeoutMs = Math.min(
    120_000,
    Math.max(45_000, Number(opts.taskTimeoutMs) || Number(process.env.STEAM_WORKER_TASK_TIMEOUT_MS) || 90_000),
  );

  const maxBrowserMs = Math.min(
    Math.min(180_000, Math.max(60_000, Number(process.env.STEAM_WORKER_MAX_BROWSER_MS) || 120_000)),
    taskTimeoutMs - 3000,
  );

  const partnerXhrWaitMs = Math.min(
    Math.min(90_000, Math.max(30_000, Number(partnerXhrWaitMsOpt) || Number(process.env.STEAM_WORKER_PARTNER_XHR_WAIT_MS) || 60_000)),
    maxBrowserMs - 5000,
  );

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();

  if (!fs.existsSync(userDataDir)) {
    return {
      ok: false,
      error: "user_data_dir_missing",
      detail: userDataDir,
      items: [],
      sessionInvalid: false,
      timedOut: false,
    };
  }

  const puppeteer = await import("puppeteer");
  const pp = puppeteer.default ?? puppeteer;

  let browser = null;

  async function runSession() {
    const jsonChunks = [];
    let partnerCs2TradeOfferXhrSeen = false;
    let partnerInventoryXhrCount = 0;
    let receivedInventoryJsonPayload = false;
    let lastInventoryJsonAt = 0;
    let lastResponseHadMoreItems = false;
    const jsonBodyTasks = [];

    const deadline = Date.now() + maxBrowserMs;
    const timeLeft = () => deadline - Date.now();

    browser = await pp.launch({
      headless: puppeteerHeadless(),
      userDataDir,
      ...(executablePath ? { executablePath } : {}),
      args: puppeteerChromeArgs(["--disable-dev-shm-usage", "--disable-gpu"]),
    });

    const page = await browser.newPage();
    await authenticatePuppeteerProxy(page);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    page.on("response", (response) => {
      const url = response.url();
      if (!isStrictPartnerCs2(url, partnerSteamId64)) return;
      if (response.status() !== 200) return;
      const task = (async () => {
        let text;
        try {
          text = await response.text();
        } catch {
          return;
        }
        const t = text.trim();
        if (!t.startsWith("{")) return;
        let data;
        try {
          data = JSON.parse(t);
        } catch {
          return;
        }
        if (!data || typeof data !== "object") return;
        if (!isUsableInventoryJson(data)) return;
        partnerCs2TradeOfferXhrSeen = true;
        partnerInventoryXhrCount += 1;
        receivedInventoryJsonPayload = true;
        lastInventoryJsonAt = Date.now();
        lastResponseHadMoreItems = inventoryHasMoreItems(data);
        jsonChunks.push(data);
        logJson("steam_worker_partner_xhr", {
          accountId,
          path: (() => {
            try {
              return new URL(url).pathname;
            } catch {
              return "";
            }
          })(),
        });
      })();
      jsonBodyTasks.push(task);
    });

    const gotoMs = Math.min(25_000, Math.max(3000, timeLeft() - 500));
    await page.goto(tradeUrlCanonical, { waitUntil: "domcontentloaded", timeout: gotoMs });
    lastInventoryJsonAt = Date.now();

    const aliveAfterGoto = await evaluateSteamSessionState(page);
    logJson("steam_worker_session_check", { accountId, phase: "after_goto", ...aliveAfterGoto });
    if (aliveAfterGoto.loginWall) {
      return {
        ok: false,
        error: "session_invalid",
        detail: "login_wall",
        items: [],
        sessionInvalid: true,
        timedOut: false,
      };
    }

    const tradeUiMs = Math.min(55_000, Math.max(4000, timeLeft() - 3000));
    try {
      await waitForTradeUi(page, tradeUiMs);
    } catch {
      const alive = await evaluateSteamSessionState(page);
      if (alive.loginWall) {
        return {
          ok: false,
          error: "session_invalid",
          detail: "login_wall_trade_ui",
          items: [],
          sessionInvalid: true,
          timedOut: false,
        };
      }
      throw new Error("trade_ui_timeout");
    }

    await page.click("#trade_theirs .trade_item_box, #trade_theirs").catch(() => {});
    await selectPartnerCs2Inventory(page);
    await sleep(250);
    await selectPartnerCs2Inventory(page);

    const xhrDeadline = Math.min(Date.now() + partnerXhrWaitMs, deadline - 1000);
    while (Date.now() < xhrDeadline && timeLeft() > 500) {
      await Promise.allSettled(jsonBodyTasks);
      if (partnerCs2TradeOfferXhrSeen) break;
      await sleep(200);
    }

    await Promise.allSettled(jsonBodyTasks);

    if (!partnerCs2TradeOfferXhrSeen) {
      const alive = await evaluateSteamSessionState(page);
      const sessionDead = alive.loginWall || !alive.tradeSurfacePresent;
      const noPartnerXhr = partnerInventoryXhrCount === 0 && !receivedInventoryJsonPayload;
      if (sessionDead || noPartnerXhr) {
        logJson("steam_worker_session_invalid", { accountId, sessionDead, noPartnerXhr });
        return {
          ok: false,
          error: "session_invalid",
          detail: sessionDead ? "no_trade_surface" : "no_partnerinventory_xhr",
          items: [],
          sessionInvalid: true,
          timedOut: false,
        };
      }
      return {
        ok: false,
        error: "timeout",
        detail: "partnerinventory_cs2_xhr",
        items: [],
        sessionInvalid: false,
        timedOut: true,
      };
    }

    const idleMs = 1200;
    const idleDeadline = Date.now() + idleMs;
    while (Date.now() < idleDeadline && timeLeft() > 300) {
      await Promise.allSettled(jsonBodyTasks);
      const idle = lastInventoryJsonAt > 0 ? Date.now() - lastInventoryJsonAt : 0;
      if (!lastResponseHadMoreItems && idle >= idleMs) break;
      await sleep(200);
    }
    await Promise.allSettled(jsonBodyTasks);

    const merged = mergeCommunityInventoryJson(jsonChunks);
    const items = mergedToItems(merged);

    logJson("steam_worker_inventory_ok", {
      accountId,
      itemCount: items.length,
      xhrCount: partnerInventoryXhrCount,
    });

    return {
      ok: true,
      error: null,
      items,
      raw: merged,
      sessionInvalid: false,
      timedOut: false,
    };
  }

  try {
    return await runWithTimeout(runSession, taskTimeoutMs);
  } catch (e) {
    if (e?.code === "TASK_TIMEOUT") {
      logJson("steam_worker_task_timeout", { accountId, taskTimeoutMs });
      try {
        const proc = browser?.process?.();
        if (proc) proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        error: "task_timeout",
        detail: "wall_clock_task_timeout",
        items: [],
        sessionInvalid: false,
        timedOut: true,
      };
    }
    const msg = e?.message || String(e);
    logJson("steam_worker_inventory_error", { accountId, message: msg });
    return {
      ok: false,
      error: "puppeteer_error",
      detail: msg,
      items: [],
      sessionInvalid: false,
      timedOut: msg.includes("timeout") || msg.includes("Timeout"),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
  }
}
