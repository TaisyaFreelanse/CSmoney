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

      const phaseKey = detectPhaseFromName(item.market_hash_name);

      try {
        await prisma.priceCatalogItem.upsert({
          where: {
            marketHashName_phaseKey_providerKey: {
              marketHashName: item.market_hash_name,
              phaseKey,
              providerKey: p.provider_key,
            },
          },
          create: {
            marketHashName: item.market_hash_name,
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

/**
 * Some PriceEmpire entries may already include phase in the name
 * (e.g. "★ Karambit | Doppler (Factory New) - Phase 2").
 * Detect and return the phaseKey.
 */
function detectPhaseFromName(name: string): string {
  const phases = [
    "Phase 1",
    "Phase 2",
    "Phase 3",
    "Phase 4",
    "Emerald",
    "Sapphire",
    "Ruby",
    "Black Pearl",
  ];
  for (const p of phases) {
    if (name.includes(p)) return p;
  }
  return "default";
}

// ---------------------------------------------------------------------------
// Price resolution: given an item, resolve the final display price
// ---------------------------------------------------------------------------

export interface ResolvedPrice {
  priceUsd: number; // cents
  source: "catalog" | "manual" | "unavailable";
  belowThreshold: boolean;
}

export async function resolvePrice(
  marketHashName: string,
  phaseLabel: string | null,
  assetId: string | null,
  side: "owner" | "guest",
): Promise<ResolvedPrice> {
  const settings = await getPricingSettings();

  // Check manual price first (owner items only)
  if (side === "owner" && assetId) {
    const manual = await prisma.ownerManualPrice.findUnique({
      where: { assetId },
    });
    if (manual) {
      return {
        priceUsd: Math.round(Number(manual.priceUsd) * 100),
        source: "manual",
        belowThreshold: false,
      };
    }
  }

  const phaseKey = phaseLabel ?? "default";
  const provider = settings.selectedPriceProvider;

  // Try exact phase match, then fallback to "default"
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

  if (!catalogItem) {
    return { priceUsd: 0, source: "unavailable", belowThreshold: true };
  }

  const baseCents = catalogItem.priceUsd;
  const baseDollars = baseCents / 100;

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
