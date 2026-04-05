/**
 * Supported display currencies (prices stored in USD cents; these are units per 1 USD).
 * Defaults match previous hardcoded UI until the first successful API sync.
 */
export const SUPPORTED_FX = ["USD", "EUR", "RUB", "CNY", "UAH"] as const;
export type SupportedFxCode = (typeof SUPPORTED_FX)[number];

export const DEFAULT_FX_RATES: Record<SupportedFxCode, number> = {
  USD: 1,
  EUR: 0.92,
  RUB: 92,
  CNY: 7.25,
  UAH: 41.5,
};

export type ExchangeRateApiV6Success = {
  result: "success";
  base_code: string;
  conversion_rates: Record<string, number>;
  time_last_update_utc?: string;
};

export type ExchangeRateApiV6Error = {
  result: "error";
  "error-type"?: string;
};

/** Pick supported codes from API conversion_rates (base USD). */
export function ratesFromConversionTable(
  conversion_rates: Record<string, number>,
): Record<SupportedFxCode, number> {
  const out = { ...DEFAULT_FX_RATES };
  for (const code of SUPPORTED_FX) {
    if (code === "USD") {
      out.USD = 1;
      continue;
    }
    const r = conversion_rates[code];
    if (typeof r === "number" && Number.isFinite(r) && r > 0) {
      out[code] = r;
    }
  }
  return out;
}
