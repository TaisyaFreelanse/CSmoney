import { describe, it, expect } from "vitest";
import {
  checkTradeBalance,
  tradeOverpayPercent,
  maxGuestTotalCentsAtOverpayCap,
  TRADE_MAX_OVERPAY_PERCENT,
  MAX_TRADE_ITEMS_PER_SIDE,
} from "../trade-balance";

describe("tradeOverpayPercent", () => {
  it("returns 0 when equal", () => {
    expect(tradeOverpayPercent(1000, 1000)).toBe(0);
  });

  it("returns positive for overpay", () => {
    expect(tradeOverpayPercent(1050, 1000)).toBeCloseTo(5, 5);
  });

  it("returns negative for underpay", () => {
    expect(tradeOverpayPercent(900, 1000)).toBeCloseTo(-10, 5);
  });

  it("returns null when ownerTotal is 0", () => {
    expect(tradeOverpayPercent(500, 0)).toBeNull();
  });
});

describe("maxGuestTotalCentsAtOverpayCap", () => {
  it("gives 105% of owner total for 5% cap", () => {
    expect(maxGuestTotalCentsAtOverpayCap(10000)).toBe(10500);
  });

  it("rounds correctly", () => {
    expect(maxGuestTotalCentsAtOverpayCap(333)).toBe(350);
  });
});

describe("checkTradeBalance", () => {
  it("returns ok when guest equals owner (0% overpay)", () => {
    const result = checkTradeBalance(5000, 5000);
    expect(result.ok).toBe(true);
  });

  it("returns ok at exactly 5% overpay", () => {
    const result = checkTradeBalance(10500, 10000);
    expect(result.ok).toBe(true);
  });

  it("returns overpay_too_low when guest < owner", () => {
    const result = checkTradeBalance(4900, 5000);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      reason: "overpay_too_low",
      shortfallCents: 100,
    });
  });

  it("returns overpay_too_high when guest > max", () => {
    const result = checkTradeBalance(10600, 10000);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      reason: "overpay_too_high",
      excessCents: 100,
    });
  });

  it("returns no_pricing when guest is 0", () => {
    const result = checkTradeBalance(0, 5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_pricing");
  });

  it("returns no_pricing when owner is 0", () => {
    const result = checkTradeBalance(5000, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_pricing");
  });

  it("accepts 4.6% overpay (user reported scenario)", () => {
    // guest = 5962.76 USD (596276 cents), owner = 5699.37 USD (569937 cents)
    // overpay = (596276 - 569937) / 569937 ≈ 4.62%
    const result = checkTradeBalance(596276, 569937);
    expect(result.ok).toBe(true);
  });
});

describe("constants", () => {
  it("TRADE_MAX_OVERPAY_PERCENT is 5", () => {
    expect(TRADE_MAX_OVERPAY_PERCENT).toBe(5);
  });

  it("MAX_TRADE_ITEMS_PER_SIDE is 30", () => {
    expect(MAX_TRADE_ITEMS_PER_SIDE).toBe(30);
  });
});
