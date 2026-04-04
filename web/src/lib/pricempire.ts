/**
 * PriceEmpire integration: fetch catalog prices and upsert into PriceCatalogItem.
 */

import { prisma } from "@/lib/prisma";

const API_BASE = "https://api.pricempire.com/v4/trader/items/prices";

export interface PriceEmpireItem {
  market_hash_name: string;
  prices: Array<{
    price: number; // cents
    count?: number;
    updated_at?: string;
    provider_key: string;
  }>;
}

/**
 * Fetch all CS2 prices from PriceEmpire for the given sources.
 * Returns raw items array.
 */
export async function fetchPriceEmpireCatalog(
  sources: string[] = ["buff163", "skins"],
): Promise<PriceEmpireItem[]> {
  const apiKey = process.env.PRICEMPIRE_API_KEY;
  if (!apiKey) throw new Error("PRICEMPIRE_API_KEY not set");

  const params = new URLSearchParams({
    app_id: "730",
    sources: sources.join(","),
    currency: "USD",
  });

  const res = await fetch(`${API_BASE}?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PriceEmpire ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Run a full price sync: fetch catalog, upsert into DB.
 * Returns number of upserted rows and any errors.
 */
export async function syncPrices(): Promise<{
  upserted: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let items: PriceEmpireItem[];

  try {
    items = await fetchPriceEmpireCatalog();
  } catch (e) {
    return { upserted: 0, errors: [(e as Error).message] };
  }

  let upserted = 0;

  for (const item of items) {
    for (const p of item.prices) {
      if (p.price <= 0) continue;

      const { baseName, phaseKey } = extractPhaseFromName(item.market_hash_name);

      try {
        await prisma.priceCatalogItem.upsert({
          where: {
            marketHashName_phaseKey_providerKey: {
              marketHashName: baseName,
              phaseKey,
              providerKey: p.provider_key,
            },
          },
          create: {
            marketHashName: baseName,
            phaseKey,
            providerKey: p.provider_key,
            priceUsd: p.price,
          },
          update: {
            priceUsd: p.price,
          },
        });
        upserted++;
      } catch (e) {
        errors.push(`${item.market_hash_name}: ${(e as Error).message}`);
        if (errors.length > 50) break;
      }
    }
    if (errors.length > 50) break;
  }

  return { upserted, errors: errors.slice(0, 20) };
}

const PHASE_NAMES = [
  "Phase 1",
  "Phase 2",
  "Phase 3",
  "Phase 4",
  "Emerald",
  "Sapphire",
  "Ruby",
  "Black Pearl",
];

/**
 * PriceEmpire appends phase as a suffix: "... - Phase 2", "... - Ruby".
 * Returns { baseName: name without suffix, phaseKey }.
 */
function extractPhaseFromName(name: string): { baseName: string; phaseKey: string } {
  for (const p of PHASE_NAMES) {
    const suffix = ` - ${p}`;
    if (name.endsWith(suffix)) {
      return { baseName: name.slice(0, -suffix.length), phaseKey: p };
    }
  }
  return { baseName: name, phaseKey: "default" };
}

// ---------------------------------------------------------------------------
// Price resolution: given an item, resolve the final display price
// ---------------------------------------------------------------------------

export interface ResolvedPrice {
  priceUsd: number; // cents
  source: "catalog" | "manual" | "unavailable";
  belowThreshold: boolean;
}

/**
 * Cents that count toward trade balance (must match trade UI: items with belowThreshold
 * are excluded from "Вы отдаёте" / "Вы получаете" sums even though resolvePrice still
 * returns a raw catalog cents value for display).
 */
export function centsCountedInTradeTotal(p: ResolvedPrice): number {
  if (p.belowThreshold) return 0;
  return p.priceUsd;
}

export async function resolvePrice(
  marketHashName: string,
  phaseLabel: string | null,
  assetId: string | null,
  side: "owner" | "guest",
): Promise<ResolvedPrice> {
  const settings = await getPricingSettings();

  const manual =
    side === "owner" && assetId
      ? await prisma.ownerManualPrice.findUnique({ where: { assetId } })
      : null;

  const phaseKey = phaseLabel ?? "default";
  const provider = settings.selectedPriceProvider;

  let catalogItem = await prisma.priceCatalogItem.findUnique({
    where: {
      marketHashName_phaseKey_providerKey: {
        marketHashName,
        phaseKey,
        providerKey: provider,
      },
    },
  });

  if (!catalogItem && phaseKey !== "default") {
    catalogItem = await prisma.priceCatalogItem.findUnique({
      where: {
        marketHashName_phaseKey_providerKey: {
          marketHashName,
          phaseKey: "default",
          providerKey: provider,
        },
      },
    });
  }

  const manualMode = manual?.mode === "markup_percent" ? "markup_percent" : "fixed";

  // Fixed USD override — no catalog required
  if (manual && manualMode === "fixed" && manual.priceUsd != null) {
    const dollars = Number(manual.priceUsd);
    if (dollars > 0) {
      return {
        priceUsd: Math.round(dollars * 100),
        source: "manual",
        belowThreshold: false,
      };
    }
  }

  if (!catalogItem) {
    return { priceUsd: 0, source: "unavailable", belowThreshold: true };
  }

  const baseCents = catalogItem.priceUsd;
  const baseDollars = baseCents / 100;

  // Extra % on catalog (after global owner markup), still counts as manual for UI
  if (manual && manualMode === "markup_percent" && manual.markupPercent != null) {
    const withOwner = Math.round(baseCents * (1 + settings.markupOwnerPercent / 100));
    const finalCents = Math.round(withOwner * (1 + manual.markupPercent / 100));
    return {
      priceUsd: finalCents,
      source: "manual",
      belowThreshold: false,
    };
  }

  if (baseDollars < settings.minPriceThresholdUsd) {
    return { priceUsd: baseCents, source: "catalog", belowThreshold: true };
  }

  const markup =
    side === "owner"
      ? settings.markupOwnerPercent
      : settings.markupGuestPercent;

  const finalCents = Math.round(baseCents * (1 + markup / 100));

  return { priceUsd: finalCents, source: "catalog", belowThreshold: false };
}

let _settingsCache: {
  data: Awaited<ReturnType<typeof _loadSettings>>;
  at: number;
} | null = null;

async function _loadSettings() {
  let s = await prisma.pricingSettings.findUnique({
    where: { id: "singleton" },
  });
  if (!s) {
    s = await prisma.pricingSettings.create({ data: { id: "singleton" } });
  }
  return s;
}

export async function getPricingSettings() {
  const now = Date.now();
  if (_settingsCache && now - _settingsCache.at < 30_000) {
    return _settingsCache.data;
  }
  const data = await _loadSettings();
  _settingsCache = { data, at: now };
  return data;
}

export function invalidateSettingsCache() {
  _settingsCache = null;
}
