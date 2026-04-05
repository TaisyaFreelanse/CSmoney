/**
 * Fetches latest USD-based rates from ExchangeRate-API v6 and stores them in Postgres.
 * Docs: https://www.exchangerate-api.com/docs/standard-requests (Bearer auth).
 */
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_FX_RATES,
  type ExchangeRateApiV6Error,
  type ExchangeRateApiV6Success,
  ratesFromConversionTable,
} from "@/lib/fx-rates";

const FX_SNAPSHOT_ID = "singleton";

export async function fetchExchangeRatesFromApi(): Promise<{
  rates: Record<string, number>;
  timeLastUpdateUtc?: string;
}> {
  const key = process.env.EXCHANGE_RATE_API_KEY?.trim();
  if (!key) {
    throw new Error("EXCHANGE_RATE_API_KEY is not set");
  }

  const res = await fetch("https://v6.exchangerate-api.com/v6/latest/USD", {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });

  const data: ExchangeRateApiV6Success | ExchangeRateApiV6Error = await res.json();

  if (!res.ok || data.result !== "success") {
    const err = "error-type" in data ? data["error-type"] : res.statusText;
    throw new Error(`ExchangeRate-API error: ${err ?? "unknown"}`);
  }

  const rates = data.conversion_rates;
  if (!rates || typeof rates !== "object") {
    throw new Error("ExchangeRate-API: missing conversion_rates");
  }

  return {
    rates: ratesFromConversionTable(rates),
    timeLastUpdateUtc: data.time_last_update_utc,
  };
}

export async function persistFxRates(rates: Record<string, number>): Promise<void> {
  const fetchedAt = new Date();
  await prisma.fxRatesSnapshot.upsert({
    where: { id: FX_SNAPSHOT_ID },
    create: { id: FX_SNAPSHOT_ID, rates, fetchedAt },
    update: { rates, fetchedAt },
  });
}

export type SyncFxRatesResult =
  | { ok: true; rates: Record<string, number>; fetchedAt: string; skipped?: boolean }
  | { ok: false; error: string };

function minSyncIntervalHours(): number {
  const n = Number(process.env.FX_RATES_MIN_SYNC_INTERVAL_HOURS ?? "20");
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

export async function syncFxRatesFromProvider(options?: { force?: boolean }): Promise<SyncFxRatesResult> {
  const minH = minSyncIntervalHours();
  if (!options?.force && minH > 0) {
    const row = await prisma.fxRatesSnapshot.findUnique({ where: { id: FX_SNAPSHOT_ID } });
    if (row?.rates && typeof row.rates === "object") {
      const ageMs = Date.now() - row.fetchedAt.getTime();
      if (ageMs < minH * 3600000) {
        return {
          ok: true,
          skipped: true,
          rates: ratesFromConversionTable(row.rates as Record<string, number>) as Record<string, number>,
          fetchedAt: row.fetchedAt.toISOString(),
        };
      }
    }
  }

  try {
    const { rates } = await fetchExchangeRatesFromApi();
    await persistFxRates(rates);
    const row = await prisma.fxRatesSnapshot.findUnique({ where: { id: FX_SNAPSHOT_ID } });
    return {
      ok: true,
      rates: rates as Record<string, number>,
      fetchedAt: row?.fetchedAt.toISOString() ?? new Date().toISOString(),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sync_failed";
    return { ok: false, error: msg };
  }
}

export async function getFxRatesPayload(): Promise<{
  rates: Record<string, number>;
  fetchedAt: string | null;
  source: "database" | "fallback";
}> {
  const row = await prisma.fxRatesSnapshot.findUnique({ where: { id: FX_SNAPSHOT_ID } });
  if (row?.rates && typeof row.rates === "object") {
    const parsed = ratesFromConversionTable(row.rates as Record<string, number>);
    return {
      rates: parsed,
      fetchedAt: row.fetchedAt.toISOString(),
      source: "database",
    };
  }
  return {
    rates: { ...DEFAULT_FX_RATES },
    fetchedAt: null,
    source: "fallback",
  };
}
