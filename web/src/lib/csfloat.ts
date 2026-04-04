/**
 * CSFloat API integration for float values and Doppler phase detection.
 *
 * Steam's community endpoint does NOT return asset_properties (float, paint index)
 * for unauthenticated server-side requests. CSFloat API fills this gap by decoding
 * inspect links to get float values and paint indices.
 *
 * Strategy:
 * - Background enrichment: after inventory is fetched from Steam, CSFloat data is
 *   fetched asynchronously with rate limiting (~3 req/sec).
 * - In-memory cache: results are cached by assetId to avoid redundant API calls.
 * - Merge on read: when inventory is served, cached CSFloat data is merged in.
 */

import https from "node:https";

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

export interface CsFloatData {
  floatValue: number;
  paintIndex: number;
  paintSeed: number;
}

const cache = new Map<string, CsFloatData>();
let enrichmentRunning = false;
let lastEnrichmentStart = 0;
const ENRICHMENT_COOLDOWN_MS = 5 * 60 * 1000;

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
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("csfloat timeout"));
    });
  });
}

async function fetchCsFloat(
  inspectLink: string,
  apiKey: string,
): Promise<CsFloatData | null> {
  const url = `https://api.csfloat.com/?url=${encodeURIComponent(inspectLink)}`;
  try {
    const { status, body } = await httpsGet(url, {
      Authorization: apiKey,
    });
    if (status === 429) {
      console.warn("[csfloat] rate limited, backing off");
      return null;
    }
    if (status !== 200) {
      console.warn(`[csfloat] HTTP ${status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = JSON.parse(body);
    const info = json?.iteminfo;
    if (!info) return null;

    return {
      floatValue: parseFloat(info.floatvalue) || 0,
      paintIndex: parseInt(info.paintindex) || 0,
      paintSeed: parseInt(info.paintseed) || 0,
    };
  } catch (e) {
    console.error("[csfloat] fetch error:", e);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function getCachedCsFloat(assetId: string): CsFloatData | null {
  return cache.get(assetId) ?? null;
}

export function phaseFromPaintIndex(
  paintIndex: number | null | undefined,
  itemName: string,
): string | null {
  if (paintIndex == null) return null;
  if (!itemName.toLowerCase().includes("doppler")) return null;
  return PAINT_INDEX_PHASE[paintIndex] ?? null;
}

interface EnrichableItem {
  assetId: string;
  inspectLink: string | null;
  marketHashName: string;
  floatValue: number | null;
  phaseLabel: string | null;
}

/**
 * Merge cached CSFloat data into items (mutates items in-place).
 * Returns the number of items enriched.
 */
export function mergeCsFloatCache(items: EnrichableItem[]): number {
  let count = 0;
  for (const item of items) {
    const data = cache.get(item.assetId);
    if (!data) continue;
    if (data.floatValue > 0) item.floatValue = data.floatValue;
    const phase = phaseFromPaintIndex(data.paintIndex, item.marketHashName);
    if (phase) item.phaseLabel = phase;
    count++;
  }
  return count;
}

/**
 * Start background CSFloat enrichment for items.
 * Processes items with inspect links that aren't already cached.
 * Rate-limited to ~3 requests/second.
 */
export function startBackgroundEnrichment(
  items: EnrichableItem[],
  dopplerOnly = false,
): void {
  const apiKey = process.env.CSFLOAT_API_KEY;
  if (!apiKey) {
    console.warn("[csfloat] CSFLOAT_API_KEY not set, skipping enrichment");
    return;
  }

  if (enrichmentRunning) {
    console.log("[csfloat] enrichment already in progress, skipping");
    return;
  }
  if (Date.now() - lastEnrichmentStart < ENRICHMENT_COOLDOWN_MS) {
    console.log("[csfloat] enrichment cooldown active, skipping");
    return;
  }

  const toEnrich = items.filter((i) => {
    if (!i.inspectLink) return false;
    if (cache.has(i.assetId)) return false;
    if (dopplerOnly && !i.marketHashName.toLowerCase().includes("doppler"))
      return false;
    return true;
  });

  if (toEnrich.length === 0) {
    console.log("[csfloat] nothing to enrich (all cached or no inspect links)");
    return;
  }

  console.log(
    `[csfloat] starting background enrichment: ${toEnrich.length} items (doppler_only=${dopplerOnly})`,
  );
  enrichmentRunning = true;
  lastEnrichmentStart = Date.now();

  (async () => {
    let success = 0;
    let fail = 0;
    let rateLimited = 0;

    for (const item of toEnrich) {
      try {
        const data = await fetchCsFloat(item.inspectLink!, apiKey);
        if (data) {
          cache.set(item.assetId, data);
          success++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }

      if (rateLimited > 3) {
        console.warn("[csfloat] too many rate limits, stopping enrichment");
        break;
      }

      await sleep(350);
    }

    console.log(
      `[csfloat] enrichment done: success=${success}, fail=${fail}, cached_total=${cache.size}`,
    );
    enrichmentRunning = false;
  })();
}

export function getCacheStats(): {
  size: number;
  enrichmentRunning: boolean;
} {
  return { size: cache.size, enrichmentRunning };
}
