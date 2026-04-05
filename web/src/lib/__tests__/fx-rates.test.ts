import { describe, expect, it } from "vitest";

import { DEFAULT_FX_RATES, ratesFromConversionTable } from "@/lib/fx-rates";

describe("ratesFromConversionTable", () => {
  it("maps API conversion_rates to supported codes", () => {
    const r = ratesFromConversionTable({
      USD: 1,
      EUR: 0.9013,
      RUB: 92.5,
      CNY: 6.9454,
      UAH: 41.2,
      GBP: 0.77,
    });
    expect(r.USD).toBe(1);
    expect(r.EUR).toBe(0.9013);
    expect(r.RUB).toBe(92.5);
    expect(r.CNY).toBe(6.9454);
    expect(r.UAH).toBe(41.2);
  });

  it("falls back to defaults for missing or invalid codes", () => {
    const r = ratesFromConversionTable({ USD: 1, EUR: 0.88 });
    expect(r.EUR).toBe(0.88);
    expect(r.RUB).toBe(DEFAULT_FX_RATES.RUB);
    expect(r.CNY).toBe(DEFAULT_FX_RATES.CNY);
  });
});
