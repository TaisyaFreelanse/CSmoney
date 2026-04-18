import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSteamPuppeteerUserDataDir } from "@/lib/steam-puppeteer-accounts";

describe("resolveSteamPuppeteerUserDataDir", () => {
  const prev = process.env.STEAM_PUPPETEER_PROFILES_DIR;

  afterEach(() => {
    if (prev === undefined) delete process.env.STEAM_PUPPETEER_PROFILES_DIR;
    else process.env.STEAM_PUPPETEER_PROFILES_DIR = prev;
  });

  it("resolves relative segments under STEAM_PUPPETEER_PROFILES_DIR", () => {
    process.env.STEAM_PUPPETEER_PROFILES_DIR = "/mount/profiles";
    expect(resolveSteamPuppeteerUserDataDir("acc_1")).toBe(path.resolve("/mount/profiles", "acc_1"));
  });

  it("maps legacy profiles/… to a single folder under the base (no duplicate profiles)", () => {
    process.env.STEAM_PUPPETEER_PROFILES_DIR = "/mount/profiles";
    expect(resolveSteamPuppeteerUserDataDir("profiles/acc_1")).toBe(path.resolve("/mount/profiles", "acc_1"));
  });

  it("leaves absolute paths unchanged (POSIX paths unchanged even on Windows)", () => {
    process.env.STEAM_PUPPETEER_PROFILES_DIR = "/mount/profiles";
    expect(resolveSteamPuppeteerUserDataDir("/other/chromium")).toBe("/other/chromium");
  });
});
