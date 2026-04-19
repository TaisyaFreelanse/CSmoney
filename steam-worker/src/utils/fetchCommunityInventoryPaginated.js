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

/**
 * Full CS2 community inventory via Steam JSON API with pagination (`more_items` / `last_assetid`).
 * Uses the same HTTP proxy as Puppeteer when PROXY_HOST/PORT are set.
 *
 * @param {string} steamId64
 * @param {string} accountId sticky session id for proxy auth
 * @returns {Promise<{ ok: true, chunks: object[] } | { ok: false, error: string, chunks: object[] }>}
 */
export async function fetchCommunityInventoryPaginated(steamId64, accountId) {
  const host = process.env.PROXY_HOST?.trim();
  const portRaw = process.env.PROXY_PORT?.trim();
  const auth = proxyAuthForAccount(accountId);

  const maxPages = Math.min(
    200,
    Math.max(1, Number(process.env.STEAM_WORKER_INVENTORY_API_MAX_PAGES) || 80),
  );

  /** @type {import("axios").AxiosRequestConfig} */
  const baseConfig = {
    timeout: Math.min(60_000, Math.max(15_000, Number(process.env.STEAM_WORKER_INVENTORY_API_TIMEOUT_MS) || 25_000)),
    headers: BROWSER_HEADERS,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  };

  if (host && portRaw) {
    const port = Number(portRaw);
    if (!Number.isFinite(port)) {
      return { ok: false, error: "proxy_port_invalid", chunks: [] };
    }
    baseConfig.proxy = {
      protocol: "http",
      host,
      port,
      ...(auth ? { auth: { username: auth.username, password: auth.password } } : {}),
    };
  }

  const chunks = [];
  let startAssetId;
  let lastMergedCount = 0;

  for (let page = 0; page < maxPages; page++) {
    let url = `https://steamcommunity.com/inventory/${encodeURIComponent(steamId64)}/${CS2_APP_ID}/${CS2_CONTEXT_ID}?l=english&count=2000`;
    if (startAssetId) url += `&start_assetid=${encodeURIComponent(startAssetId)}`;

    let status;
    let data;
    try {
      const resp = await axios.get(url, baseConfig);
      status = resp.status;
      data = resp.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logJson("steam_worker_inventory_api_error", { accountId, page, message: msg });
      if (chunks.length > 0) return { ok: true, chunks };
      return { ok: false, error: `inventory_api_http_error:${msg}`, chunks: [] };
    }

    if (status === 403) {
      if (chunks.length > 0) return { ok: true, chunks };
      return { ok: false, error: "private_inventory", chunks: [] };
    }
    if (status === 429) {
      if (chunks.length > 0) return { ok: true, chunks };
      return { ok: false, error: "steam_rate_limit", chunks: [] };
    }
    if (status !== 200 || !data || typeof data !== "object") {
      if (chunks.length > 0) return { ok: true, chunks };
      return { ok: false, error: `steam_http_${status}`, chunks: [] };
    }

    if (!isUsableInventoryJson(data)) {
      if (chunks.length > 0) return { ok: true, chunks };
      return { ok: false, error: "inventory_api_not_json_inventory", chunks: [] };
    }

    chunks.push(data);

    const merged = mergeCommunityInventoryJson(chunks);
    const n = merged.assets?.length ?? 0;
    const more = inventoryHasMoreItems(data);
    const lastId = data.last_assetid != null ? String(data.last_assetid) : "";

    logJson("steam_worker_inventory_api_page", {
      accountId,
      page,
      pageAssets: Array.isArray(data.assets) ? data.assets.length : 0,
      mergedAssets: n,
      more_items: more,
      total_inventory_count: data.total_inventory_count ?? null,
    });

    if (!more || !lastId) break;

    if (lastId === startAssetId) {
      logJson("steam_worker_inventory_api_pagination_stuck", { accountId, page, lastId });
      break;
    }

    if (n === lastMergedCount && page > 0) {
      logJson("steam_worker_inventory_api_no_progress", { accountId, page, mergedAssets: n });
      break;
    }
    lastMergedCount = n;

    const steamTotal = Number(data.total_inventory_count);
    if (Number.isFinite(steamTotal) && steamTotal > 0 && n >= steamTotal) break;

    startAssetId = lastId;
  }

  if (chunks.length === 0) return { ok: false, error: "empty_inventory", chunks: [] };

  const finalMerged = mergeCommunityInventoryJson(chunks);
  if ((finalMerged.assets?.length ?? 0) === 0) {
    return { ok: false, error: "empty_inventory", chunks: [] };
  }

  return { ok: true, chunks };
}
