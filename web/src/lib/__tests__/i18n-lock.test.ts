import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmtLockI18n } from "../i18n";

describe("fmtLockI18n", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts hours from UTC instant vs Date.now(), not local calendar", () => {
    vi.setSystemTime(new Date("2028-04-30T12:00:00.000Z"));
    const iso = "2028-05-01T00:00:00.000Z";
    expect(fmtLockI18n(iso, "en")).toBe("12h");
    expect(fmtLockI18n(iso, "ru")).toBe("12ч");
  });

  it("returns empty when unlock is in the past", () => {
    vi.setSystemTime(new Date("2028-05-02T00:00:00.000Z"));
    expect(fmtLockI18n("2028-05-01T00:00:00.000Z", "en")).toBe("");
  });
});
