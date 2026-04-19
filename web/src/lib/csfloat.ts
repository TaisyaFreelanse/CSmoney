/**
 * Float / phase via CSFloat API with Redis cache (inspect link → payload, 7d TTL),
 * multiple API keys (round-robin), bounded concurrency, rate-limit retry.
 */

import "server-only";

import crypto from "node:crypto";
import https from "node:https";

import type { NormalizedItem } from "./steam-inventory";
import { getRedis } from "./redis-client";

const PAINT_INDEX_PHASE: Record<number, string> = {
  415: "Ruby",
  416: "Sapphire",
  417: "Black Pearl",
  418: "Phase 1",
  419: "Phase 2",
  420: "Phase 3",
  421: "Phase 4",
  568: "Emerald",
  569: "Phase 1",
  570: "Phase 2",
  571: "Phase 3",
  572: "Phase 4",
};

const CACHE_PREFIX = "csmoney:csfloat:inspect:";
const TTL_SEC = 7 * 24 * 3600;

const memoryInspectCache = new Map<string, InspectData>();

const CSFLOAT_MAX_PARALLEL = Math.max(
  1,
  Math.min(20, parseInt(process.env.CSFLOAT_MAX_PARALLEL ?? "8", 10) || 8),
);

let csfloatParallel = 0;
const csfloatWaiters: Array<() => void> = [];

async function acquireCsFloatSlot(): Promise<void> {
  if (csfloatParallel < CSFLOAT_MAX_PARALLEL) {
    csfloatParallel++;
    return;
  }
  await new Promise<void>((resolve) => {
    csfloatWaiters.push(() => {
      csfloatParallel++;
      resolve();
    });
  });
}

function releaseCsFloatSlot(): void {
  csfloatParallel--;
  const w = csfloatWaiters.shift();
  if (w) w();
}

function parseApiKeys(): string[] {
  const multi = process.env.CSFLOAT_API_KEYS?.trim();
  if (multi) {
    const parts = multi
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts;
  }
  const one = process.env.CSFLOAT_API_KEY?.trim();
  return one ? [one] : [];
}

let keyIndex = 0;

export interface InspectData {
  floatValue: number;
  paintIndex: number;
  paintSeed: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function httpsGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("csfloat api timeout"));
    });
  });
}

function parseInspectParams(link: string): { s: string; a: string; d: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    decoded = link;
  }
  const m = /S(\d+)A(\d+)D(\d+)/.exec(decoded);
  if (!m) return null;
  return { s: m[1], a: m[2], d: m[3] };
}

function cacheKeyForInspectLink(link: string): string {
  const h = crypto.createHash("sha256").update(link).digest("hex");
  return `${CACHE_PREFIX}${h}`;
}

async function readInspectCache(link: string): Promise<InspectData | null> {
  const mem = memoryInspectCache.get(link);
  if (mem) return mem;

  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(cacheKeyForInspectLink(link));
    if (raw == null || raw === "") return null;
    const parsed = JSON.parse(raw) as InspectData;
    if (
      parsed &&
      typeof parsed.floatValue === "number" &&
      typeof parsed.paintIndex === "number" &&
      typeof parsed.paintSeed === "number"
    ) {
      memoryInspectCache.set(link, parsed);
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeInspectCache(link: string, data: InspectData): Promise<void> {
  memoryInspectCache.set(link, data);
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(cacheKeyForInspectLink(link), JSON.stringify(data), "EX", TTL_SEC);
  } catch {
    /* ignore */
  }
}

async function fetchFromCsFloatOnce(
  s: string,
  a: string,
  d: string,
  apiKey: string,
): Promise<{ status: number; body: string }> {
  const url = `https://api.csfloat.com/?s=${s}&a=${a}&d=${d}`;
  return httpsGet(url, {
    Accept: "application/json",
    Authorization: apiKey,
  });
}

async function fetchInspectDataFromApi(
  s: string,
  a: string,
  d: string,
): Promise<InspectData | null> {
  const keys = parseApiKeys();
  if (keys.length === 0) return null;

  let delay = 400;
  const maxAttempts = keys.length * 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slot = (keyIndex + attempt) % keys.length;
    const key = keys[slot];
    if (!key) break;
    await acquireCsFloatSlot();
    try {
      const { status, body } = await fetchFromCsFloatOnce(s, a, d, key);
      if (status === 429) {
        console.log(
          JSON.stringify({
            type: "csfloat_fetch",
            event: "rate_limited",
            keySlot: slot,
            ts: Date.now(),
          }),
        );
        await sleep(delay);
        delay = Math.min(delay * 2, 10_000);
        continue;
      }
      if (status !== 200) {
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        continue;
      }
      const info = (json as { iteminfo?: unknown })?.iteminfo ?? json;
      if (!info || typeof info !== "object") continue;

      const floatValue =
        parseFloat(String((info as { floatvalue?: unknown }).floatvalue ?? (info as { float_value?: unknown }).float_value ?? "0")) || 0;
      const paintIndex =
        parseInt(String((info as { paintindex?: unknown }).paintindex ?? (info as { paint_index?: unknown }).paint_index ?? "0"), 10) || 0;
      const paintSeed =
        parseInt(String((info as { paintseed?: unknown }).paintseed ?? (info as { paint_seed?: unknown }).paint_seed ?? "0"), 10) || 0;

      keyIndex = (slot + 1) % keys.length;
      return { floatValue, paintIndex, paintSeed };
    } catch (err) {
      console.error("[csfloat] fetch error:", err);
    } finally {
      releaseCsFloatSlot();
    }
  }
  return null;
}

export function phaseFromPaintIndex(
  paintIndex: number | null | undefined,
  itemName: string,
): string | null {
  if (paintIndex == null) return null;
  if (!itemName.toLowerCase().includes("doppler")) return null;
  return PAINT_INDEX_PHASE[paintIndex] ?? null;
}

export function mergeInspectCache(
  items: Array<{
    assetId: string;
    inspectLink: string | null;
    marketHashName: string;
    floatValue: number | null;
    phaseLabel: string | null;
  }>,
): number {
  let count = 0;
  for (const item of items) {
    const data = memoryInspectCache.get(item.inspectLink ?? "");
    if (!data || !item.inspectLink) continue;
    if (data.floatValue > 0) item.floatValue = data.floatValue;
    const phase = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
    if (phase) item.phaseLabel = phase;
    count++;
  }
  return count;
}

export type CsFloatEnrichLog = {
  totalItems: number;
  newWithoutApi: number;
  sentToCsfloat: number;
  cacheHits: number;
  enriched: number;
  failed: number;
  durationMs: number;
  keyRotations: number;
};

/**
 * CSFloat for any merged item that still lacks float (after Steam API + trade merge), with inspect-link cache.
 * `apiAssetIds` is kept for metrics (`newWithoutApi`); API-sourced rows without `asset_properties` float still qualify.
 * Mutates items in place.
 */
export async function enrichNewItemsWithCsFloat(
  items: NormalizedItem[],
  apiAssetIds: Set<string>,
  logCtx?: { taskId?: string },
): Promise<CsFloatEnrichLog> {
  const t0 = Date.now();
  const keys = parseApiKeys();
  if (keys.length === 0) {
    return {
      totalItems: items.length,
      newWithoutApi: 0,
      sentToCsfloat: 0,
      cacheHits: 0,
      enriched: 0,
      failed: 0,
      durationMs: Date.now() - t0,
      keyRotations: 0,
    };
  }

  const targets = items.filter(
    (i) => i.inspectLink && (i.floatValue == null || i.floatValue <= 0),
  );
  const newWithoutApi = items.filter((i) => !apiAssetIds.has(i.assetId)).length;

  console.log(
    JSON.stringify({
      type: "csfloat_enrich_start",
      keysConfigured: keys.length,
      inspectCacheTtlDays: TTL_SEC / (24 * 3600),
      apiAssetIdCount: apiAssetIds.size,
      itemsNeedingFloatRequest: targets.length,
      newWithoutApiCount: newWithoutApi,
      maxParallel: CSFLOAT_MAX_PARALLEL,
      ts: Date.now(),
    }),
  );

  let cacheHits = 0;
  let enriched = 0;
  let failed = 0;
  let sentToCsfloat = 0;
  const keySlotStart = keyIndex;

  for (const item of targets) {
    const link = item.inspectLink!;
    const cached = await readInspectCache(link);
    if (cached) {
      cacheHits++;
      if (cached.floatValue > 0) item.floatValue = cached.floatValue;
      const ph = phaseFromPaintIndex(cached.paintIndex, item.marketHashName);
      if (ph) item.phaseLabel = ph;
      enriched++;
      continue;
    }

    const params = parseInspectParams(link);
    if (!params || params.s === "0") {
      failed++;
      continue;
    }

    sentToCsfloat++;
    const data = await fetchInspectDataFromApi(params.s, params.a, params.d);
    if (data === null) {
      failed++;
      continue;
    }
    if (data.floatValue > 0 || data.paintIndex > 0) {
      await writeInspectCache(link, data);
      if (data.floatValue > 0) item.floatValue = data.floatValue;
      const ph = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
      if (ph) item.phaseLabel = ph;
      enriched++;
    } else {
      failed++;
    }

    await sleep(120);
  }

  const log: CsFloatEnrichLog = {
    totalItems: items.length,
    newWithoutApi,
    sentToCsfloat,
    cacheHits,
    enriched,
    failed,
    durationMs: Date.now() - t0,
    keyRotations: Math.abs(keyIndex - keySlotStart),
  };

  console.log(
    JSON.stringify({
      type: "guest_inv_csfloat",
      ...logCtx,
      ...log,
      ts: Date.now(),
    }),
  );

  return log;
}

/** @deprecated Prefer enrichNewItemsWithCsFloat; kept for compatibility. */
export function enrichFromInspectLinks(
  items: Array<{
    assetId: string;
    inspectLink: string | null;
    marketHashName: string;
    floatValue: number | null;
    phaseLabel: string | null;
  }>,
): number {
  return mergeInspectCache(items);
}
