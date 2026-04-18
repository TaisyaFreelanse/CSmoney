import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("STEAM_PUPPETEER_COOKIES_DISABLED", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resolveGuestPuppeteerSession blocks cookies and allows profile", async () => {
    vi.stubEnv("STEAM_PUPPETEER_COOKIES_DISABLED", "1");
    vi.stubEnv("STEAM_COMMUNITY_COOKIES", "sessionid=x");
    vi.stubEnv("STEAM_INVENTORY_BROWSER", "1");
    const { resolveGuestPuppeteerSession } = await import("@/lib/guest-inventory-puppeteer");
    expect(resolveGuestPuppeteerSession()).toEqual({ ok: false, reason: "steam_puppeteer_profiles_only" });
    const prof = resolveGuestPuppeteerSession({ userDataDir: "/mount/profiles/guest1" });
    expect(prof.ok && prof.mode === "profile").toBe(true);
  });

  it("parseAccountsFromEnv skips STEAM_COMMUNITY_COOKIES fallback when disabled", async () => {
    vi.stubEnv("STEAM_PUPPETEER_COOKIES_DISABLED", "1");
    vi.stubEnv("STEAM_COMMUNITY_COOKIES", "sessionid=x; steamLoginSecure=y");
    vi.stubEnv("STEAM_PUPPETEER_ACCOUNTS_JSON", "");
    const { guestPuppeteerAccountCount } = await import("@/lib/steam-puppeteer-accounts");
    expect(guestPuppeteerAccountCount()).toBe(0);
  });

  it("JSON with userDataDir yields account without cookie fallback when ST_COMMUNITY_COOKIES set", async () => {
    vi.stubEnv("STEAM_PUPPETEER_COOKIES_DISABLED", "1");
    vi.stubEnv("STEAM_COMMUNITY_COOKIES", "sessionid=only");
    vi.stubEnv(
      "STEAM_PUPPETEER_ACCOUNTS_JSON",
      JSON.stringify([
        {
          id: "w1",
          steamId64: "76561198000000001",
          userDataDir: "/tmp/steam-prof-test-w1",
        },
      ]),
    );
    const { nextGuestPuppeteerAccount } = await import("@/lib/steam-puppeteer-accounts");
    const acc = nextGuestPuppeteerAccount();
    expect(acc?.userDataDir).toContain("steam-prof-test-w1");
    expect(acc?.cookies).toBeUndefined();
  });
});
