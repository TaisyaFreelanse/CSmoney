/**
 * HTTP client: Render (Next) → Hetzner steam-worker GET /inventory.
 * Retries, timeouts, optional Redis cache (same key shape for sync + job completion).
 */

import "server-only";

import crypto from "node:crypto";

import { parseTradeUrl } from "@/lib/steam-community-url";
import { getRedis } from "@/lib/redis-client";

const CACHE_KEY_PREFIX = "csmoney:render:worker_inv:v1:";
const JOB_KEY_PREFIX = "csmoney:render:worker_inv_job:v1:";

export type SteamWorkerInventoryMeta = {
  schemaVersion: number;
  cacheHit?: boolean;
  api?: Record<string, unknown>;
  trade?: Record<string, unknown> | null;
};

export type SteamWorkerInventoryBody = {
  items: unknown[];
  /** Merged Steam inventory JSON (assets + descriptions + asset_properties) for web-side `normalizeInventory`. */
  raw?: unknown;
  source: string | null;
  accountId: string | null;
  durationMs: number;
  error: string | null;
  meta?: SteamWorkerInventoryMeta;
  [key: string]: unknown;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Canonical trade URL for cache keys (same as steam-worker steamUrl.tradeUrlFromParsed). */
export function canonicalTradeUrlForWorkerCache(raw: string): string | null {
  const p = parseTradeUrl(raw);
  if (!p) return null;
  return `https://steamcommunity.com/tradeoffer/new/?partner=${encodeURIComponent(p.partner)}&token=${encodeURIComponent(p.token)}`;
}

function cacheKeyForTradeUrl(canonical: string): string {
  const h = crypto.createHash("sha256").update(canonical).digest("hex");
  return `${CACHE_KEY_PREFIX}${h}`;
}

function jobKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

export type WorkerInventoryJobRecord =
  | { status: "pending"; createdAt: number; createdBySteamId: string | null; canonicalTradeUrl: string }
  | {
      status: "running";
      createdAt: number;
      startedAt: number;
      createdBySteamId: string | null;
      canonicalTradeUrl: string;
    }
  | {
      status: "complete";
      createdAt: number;
      finishedAt: number;
      httpStatus: number;
      result: SteamWorkerInventoryBody;
      createdBySteamId: string | null;
      canonicalTradeUrl: string;
    }
  | {
      status: "failed";
      createdAt: number;
      finishedAt: number;
      error: string;
      createdBySteamId: string | null;
      canonicalTradeUrl: string;
    };

export async function readWorkerInventoryCache(canonicalTradeUrl: string): Promise<{
  httpStatus: number;
  body: SteamWorkerInventoryBody;
} | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(cacheKeyForTradeUrl(canonicalTradeUrl));
    if (!raw) return null;
    return JSON.parse(raw) as { httpStatus: number; body: SteamWorkerInventoryBody };
  } catch {
    return null;
  }
}

export async function writeWorkerInventoryCache(
  canonicalTradeUrl: string,
  payload: { httpStatus: number; body: SteamWorkerInventoryBody },
  ttlSec: number,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(cacheKeyForTradeUrl(canonicalTradeUrl), JSON.stringify(payload), "EX", ttlSec);
  } catch {
    /* ignore */
  }
}

export async function readWorkerInventoryJob(jobId: string): Promise<WorkerInventoryJobRecord | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(jobKey(jobId));
    if (!raw) return null;
    return JSON.parse(raw) as WorkerInventoryJobRecord;
  } catch {
    return null;
  }
}

export async function writeWorkerInventoryJob(jobId: string, rec: WorkerInventoryJobRecord, ttlSec: number): Promise<void> {
  const r = getRedis();
  if (!r) throw new Error("REDIS_URL is required for async worker inventory jobs");
  await r.set(jobKey(jobId), JSON.stringify(rec), "EX", ttlSec);
}

/**
 * Proxied GET to steam-worker with bounded retries (502/503/504, network).
 */
export async function fetchSteamWorkerInventoryDirect(params: {
  tradeUrl: string;
  steamId?: string;
}): Promise<{ httpStatus: number; body: SteamWorkerInventoryBody }> {
  const base = process.env.STEAM_INVENTORY_WORKER_BASE_URL?.trim().replace(/\/$/, "");
  const apiKey = process.env.STEAM_INVENTORY_WORKER_API_KEY?.trim();
  if (!base || !apiKey) {
    throw new Error("STEAM_INVENTORY_WORKER_BASE_URL and STEAM_INVENTORY_WORKER_API_KEY must be set");
  }

  const timeoutMs = Math.min(
    180_000,
    Math.max(30_000, parseInt(process.env.STEAM_INVENTORY_WORKER_HTTP_TIMEOUT_MS ?? "150000", 10) || 150_000),
  );
  const maxRetries = Math.min(8, Math.max(0, parseInt(process.env.STEAM_INVENTORY_WORKER_HTTP_RETRIES ?? "4", 10) || 4));

  const url = new URL(`${base}/inventory`);
  url.searchParams.set("tradeUrl", params.tradeUrl.trim());
  if (params.steamId?.trim()) url.searchParams.set("steamId", params.steamId.trim());

  let delay = 900;
  let lastStatus = 502;
  let lastBody: SteamWorkerInventoryBody = { items: [], source: null, accountId: null, durationMs: 0, error: "fetch_failed" };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey,
        },
        signal: ac.signal,
      });
      clearTimeout(t);
      const body = (await res.json().catch(() => ({}))) as SteamWorkerInventoryBody;
      lastStatus = res.status;
      lastBody = body;

      const retryable = res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < maxRetries) {
        await sleep(Math.min(10_000, delay));
        delay = Math.min(Math.floor(delay * 1.75), 10_000);
        continue;
      }
      if (res.status === 429 && attempt < maxRetries) {
        const ra = res.headers.get("retry-after");
        const sec = ra ? Math.min(60, Math.max(1, parseInt(ra, 10) || 3)) : 3;
        await sleep(sec * 1000);
        continue;
      }
      return { httpStatus: res.status, body };
    } catch {
      clearTimeout(t);
      if (attempt < maxRetries) {
        await sleep(Math.min(10_000, delay));
        delay = Math.min(Math.floor(delay * 1.6), 10_000);
        continue;
      }
      return {
        httpStatus: 502,
        body: {
          items: [],
          source: null,
          accountId: null,
          durationMs: 0,
          error: "worker_unreachable",
          meta: {
            schemaVersion: 1,
            cacheHit: false,
            api: { attempted: false },
            trade: null,
          },
        },
      };
    }
  }

  return { httpStatus: lastStatus, body: lastBody };
}

export function workerInventoryCacheTtlSec(): number {
  return Math.min(
    3600,
    Math.max(15, parseInt(process.env.STEAM_INVENTORY_WORKER_PROXY_CACHE_TTL_SEC ?? "90", 10) || 90),
  );
}

export function workerInventoryJobTtlSec(): number {
  return Math.min(3600, Math.max(120, parseInt(process.env.STEAM_INVENTORY_WORKER_JOB_TTL_SEC ?? "900", 10) || 900));
}
