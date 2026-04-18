#!/usr/bin/env node
/**
 * Open Chromium with a persistent userDataDir so you can log in to Steam once
 * (login + Guard). Same folder as STEAM_PUPPETEER_ACCOUNTS_JSON / OWNER_USER_DATA_DIR.
 *
 * Usage (from web/):
 *   npm run steam -- acc_1
 *   STEAM_PUPPETEER_PROFILES_DIR=/mount/profiles node scripts/steam-profile-login.mjs acc_1
 *   node scripts/steam-profile-login.mjs /mount/profiles/acc_1
 *
 * Close the browser window when done; profile stays on disk.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Match server-side `resolveSteamPuppeteerUserDataDir` (see steam-puppeteer-accounts.ts). */
function resolveUserDataDirCliArg(raw) {
  const t = raw.trim();
  if (!t) return "";
  if (path.isAbsolute(t)) return t;
  let rel = t.replace(/^[.][/\\]/, "");
  if (/^profiles[\\/]/i.test(rel)) {
    rel = rel.replace(/^profiles[\\/]/i, "");
  }
  const baseRaw = process.env.STEAM_PUPPETEER_PROFILES_DIR?.trim();
  const profilesBase = baseRaw
    ? path.isAbsolute(baseRaw)
      ? baseRaw
      : path.resolve(process.cwd(), baseRaw)
    : path.resolve(process.cwd(), "profiles");
  return path.resolve(profilesBase, rel);
}

const profileArg = process.argv[2]?.trim();
if (!profileArg) {
  console.error("Usage: node scripts/steam-profile-login.mjs <userDataDir>");
  process.exit(1);
}

const userDataDir = resolveUserDataDirCliArg(profileArg);

try {
  mkdirSync(userDataDir, { recursive: true });
} catch (e) {
  console.error("Failed to create userDataDir:", e);
  process.exit(1);
}

const headless = process.env.STEAM_PUPPETEER_HEADLESS !== "0";

async function main() {
  const puppeteer = await import("puppeteer");
  const pp = puppeteer.default ?? puppeteer;

  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (!executablePath && typeof pp.executablePath === "function") {
    try {
      executablePath = pp.executablePath();
    } catch {
      /* ignore */
    }
  }

  if (executablePath && !existsSync(executablePath)) {
    console.error("Chrome not found at PUPPETEER_EXECUTABLE_PATH:", executablePath);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      type: "steam_profile_login_script",
      userDataDir,
      headless,
      executablePath: executablePath ?? "bundled",
      hint: "Log in to Steam in the opened window, then close it. Profile is saved under userDataDir.",
    }),
  );

  const browser = await pp.launch({
    headless,
    userDataDir,
    ...(executablePath ? { executablePath } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.goto("https://steamcommunity.com/login/home/?goto=", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  console.log("Browser open — complete Steam login, then close the window or press Ctrl+C.");

  await new Promise((resolve) => {
    browser.on("disconnected", resolve);
    process.on("SIGINT", () => {
      browser.close().then(resolve).catch(resolve);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
