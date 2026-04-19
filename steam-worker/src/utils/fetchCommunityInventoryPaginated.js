import axios from "axios";
import https from "node:https";
import { mergeCommunityInventoryJson, inventoryHasMoreItems, isUsableInventoryJson } from "./inventoryMerge.js";
import { proxyAuthForAccount } from "./puppeteerProxy.js";
import { logJson } from "./logger.js";

const CS2_APP_ID = 730;
const CS2_CONTEXT_ID = 2;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseMaxPages() {
  const raw = process.env.STEAM_WORKER_INVENTORY_API_MAX_PAGES;
  if (raw === "0" || raw === "unlimited") return 2000;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(2000, Math.max(1, n));
  return 400;
}

function parsePerRequestTimeoutMs() {
  return Math.min(
    120_000,
    Math.max(20_000, Number(process.env.STEAM_WORKER_INVENTORY_API_TIMEOUT_MS) || 55_000),
  );
}

/**
 * @typedef {object} SteamInventoryApiPaginationMeta
 * @property {boolean} paginationComplete
 * @property {string} stoppedReason
 * @property {number} pagesFetched
 * @property {number} mergedAssetCount
 * @property {number | null} steamTotalInventoryCount
 * @property {boolean} lastPageHadMoreItems
 */

/**
 * @param {import("axios").AxiosInstance} client
 * @param {string} url
 * @param {{ maxAttempts: number; accountId: string; page: number }} ropts
 */
async function axiosGetWithRetries(client, url, ropts) {
  let lastMessage = "unknown";
  let delay = 700;
  for (let i = 0; i < ropts.maxAttempts; i++) {
    try {
      const resp = await client.get(url);
      if (resp.status === 429) {
        logJson("steam_worker_inventory_api_429", { accountId: ropts.accountId, page: ropts.page, attempt: i });
        await sleep(Math.min(15_000, delay));
        delay = Math.min(Math.floor(delay * 1.6), 15_000);
        continue;
      }
      return resp;
    } catch (e) {
      lastMessage = e instanceof Error ? e.message : String(e);
      logJson("steam_worker_inventory_api_retry", {
        accountId: ropts.accountId,
        page: ropts.page,
        attempt: i,
        message: lastMessage,
      });
      await sleep(Math.min(12_000, delay));
      delay = Math.min(Math.floor(delay * 1.45), 12_000);
    }
  }
  throw new Error(lastMessage);
}

/**
 * @param {string} steamId64
 * @param {string} accountId
 * @returns {Promise<
 *   | { ok: true; chunks: object[]; meta: SteamInventoryApiPaginationMeta }
 *   | { ok: false; error: string; chunks: object[]; meta?: SteamInventoryApiPaginationMeta }
 * >}
 */
export async function fetchCommunityInventoryPaginated(steamId64, accountId) {
  const host = process.env.PROXY_HOST?.trim();
  const portRaw = process.env.PROXY_PORT?.trim();
  const auth = proxyAuthForAccount(accountId);
  const maxPages = parseMaxPages();
  const perReqMs = parsePerRequestTimeoutMs();
  const maxAttemptsPerPage = Math.min(
    40,
    Math.max(4, Number(process.env.STEAM_WORKER_INVENTORY_API_PAGE_MAX_ATTEMPTS) || 18),
  );

  /** @type {import("axios").CreateAxiosDefaults} */
  const axiosBase = {
    timeout: perReqMs,
    headers: BROWSER_HEADERS,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  };

  if (host && portRaw) {
    const port = Number(portRaw);
    if (!Number.isFinite(port)) {
      return { ok: false, error: "proxy_port_invalid", chunks: [] };
    }
    axiosBase.proxy = {
      protocol: "http",
      host,
      port,
      ...(auth ? { auth: { username: auth.username, password: auth.password } } : {}),
    };
  }

  const client = axios.create(axiosBase);

  const chunks = [];
  let startAssetId;
  let lastMergedCount = 0;
  /** @type {number | null} */
  let steamTotalSeen = null;
  let lastPageHadMoreItems = false;
  /** @type {SteamInventoryApiPaginationMeta["stoppedReason"]} */
  let stoppedReason = "complete";

  for (let page = 0; page < maxPages; page++) {
    let url = `https://steamcommunity.com/inventory/${encodeURIComponent(steamId64)}/${CS2_APP_ID}/${CS2_CONTEXT_ID}?l=english&count=2000`;
    if (startAssetId) url += `&start_assetid=${encodeURIComponent(startAssetId)}`;

    let resp;
    try {
      resp = await axiosGetWithRetries(client, url, {
        maxAttempts: maxAttemptsPerPage,
        accountId,
        page,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (chunks.length > 0) {
        stoppedReason = "request_error";
        logJson("steam_worker_inventory_api_abort_after_partial", {
          accountId,
          page,
          message: msg,
          mergedSoFar: mergeCommunityInventoryJson(chunks).assets?.length ?? 0,
        });
        const mergedPartial = mergeCommunityInventoryJson(chunks);
        return {
          ok: true,
          chunks,
          meta: {
            paginationComplete: false,
            stoppedReason,
            pagesFetched: chunks.length,
            mergedAssetCount: mergedPartial.assets?.length ?? 0,
            steamTotalInventoryCount: steamTotalSeen,
            lastPageHadMoreItems: true,
          },
        };
      }
      return {
        ok: false,
        error: `inventory_api_http_error:${msg}`,
        chunks: [],
        meta: {
          paginationComplete: false,
          stoppedReason: /timeout/i.test(msg) ? "timeout" : "request_error",
          pagesFetched: 0,
          mergedAssetCount: 0,
          steamTotalInventoryCount: null,
          lastPageHadMoreItems: false,
        },
      };
    }

    const status = resp.status;
    const data = resp.data;

    if (status === 403) {
      if (chunks.length > 0) {
        stoppedReason = "http_403_mid";
        break;
      }
      return { ok: false, error: "private_inventory", chunks: [] };
    }
    if (status === 429) {
      if (chunks.length > 0) {
        stoppedReason = "rate_limit_exhausted";
        break;
      }
      return { ok: false, error: "steam_rate_limit", chunks: [] };
    }
    if (status !== 200 || !data || typeof data !== "object") {
      if (chunks.length > 0) {
        stoppedReason = `http_${status}`;
        break;
      }
      return { ok: false, error: `steam_http_${status}`, chunks: [] };
    }

    if (!isUsableInventoryJson(data)) {
      if (chunks.length > 0) {
        stoppedReason = "not_inventory_json";
        break;
      }
      return { ok: false, error: "inventory_api_not_json_inventory", chunks: [] };
    }

    chunks.push(data);

    const merged = mergeCommunityInventoryJson(chunks);
    const n = merged.assets?.length ?? 0;
    const more = inventoryHasMoreItems(data);
    const lastId = data.last_assetid != null ? String(data.last_assetid) : "";
    lastPageHadMoreItems = more;

    const t = Number(data.total_inventory_count);
    if (Number.isFinite(t) && t > 0) steamTotalSeen = t;

    logJson("steam_worker_inventory_api_page", {
      accountId,
      page,
      pageAssets: Array.isArray(data.assets) ? data.assets.length : 0,
      mergedAssets: n,
      more_items: more,
      total_inventory_count: data.total_inventory_count ?? null,
    });

    if (!more || !lastId) {
      stoppedReason = "complete";
      lastPageHadMoreItems = false;
      break;
    }

    if (lastId === startAssetId) {
      logJson("steam_worker_inventory_api_pagination_stuck", { accountId, page, lastId });
      stoppedReason = "stuck_cursor";
      break;
    }

    if (n === lastMergedCount && page > 0) {
      logJson("steam_worker_inventory_api_no_progress", { accountId, page, mergedAssets: n });
      stoppedReason = "no_progress";
      break;
    }
    lastMergedCount = n;

    const steamTotal = Number(data.total_inventory_count);
    if (Number.isFinite(steamTotal) && steamTotal > 0 && n >= steamTotal) {
      stoppedReason = "complete_total_reached";
      lastPageHadMoreItems = false;
      break;
    }

    startAssetId = lastId;

    if (page + 1 >= maxPages) {
      stoppedReason = "max_pages";
      logJson("steam_worker_inventory_api_incomplete_max_pages", {
        accountId,
        maxPages,
        mergedAssets: n,
        more_items: more,
      });
      break;
    }
  }

  if (chunks.length === 0) {
    return { ok: false, error: "empty_inventory", chunks: [] };
  }

  const finalMerged = mergeCommunityInventoryJson(chunks);
  const mergedCount = finalMerged.assets?.length ?? 0;
  if (mergedCount === 0) {
    return { ok: false, error: "empty_inventory", chunks: [] };
  }

  const steamT = steamTotalSeen;

  const paginationComplete =
    (stoppedReason === "complete" || stoppedReason === "complete_total_reached") &&
    !lastPageHadMoreItems &&
    (steamT == null || steamT <= 0 || mergedCount >= steamT);

  const meta = {
    paginationComplete,
    stoppedReason,
    pagesFetched: chunks.length,
    mergedAssetCount: mergedCount,
    steamTotalInventoryCount: steamT,
    lastPageHadMoreItems,
  };

  if (!paginationComplete) {
    logJson("steam_worker_inventory_api_pagination_incomplete", { accountId, ...meta });
  }

  return { ok: true, chunks, meta };
}
