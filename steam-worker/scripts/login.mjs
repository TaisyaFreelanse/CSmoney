#!/usr/bin/env node
/**
 * Manual Steam login into a persistent userDataDir.
 * Usage: npm run login -- acc1
 * Requires STEAM_ACCOUNTS in env (or pass profile path as only arg for quick login).
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const arg = process.argv[2]?.trim();
if (!arg) {
  console.error("Usage: npm run login -- <accountId|path-to-profile>");
  process.exit(1);
}

function resolveProfileDir(idOrPath) {
  const raw = process.env.STEAM_ACCOUNTS?.trim();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const row = arr.find((x) => x && x.id === idOrPath);
        if (row?.userDataDir) {
          const rel = String(row.userDataDir).trim();
          return path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (path.isAbsolute(idOrPath)) return idOrPath;
  const base = process.env.STEAM_PUPPETEER_PROFILES_DIR?.trim();
  const profilesBase = base
    ? path.isAbsolute(base)
      ? base
      : path.resolve(process.cwd(), base)
    : path.resolve(process.cwd(), "profiles");
  return path.resolve(profilesBase, idOrPath.replace(/^profiles[\\/]/i, ""));
}

const userDataDir = resolveProfileDir(arg);

try {
  mkdirSync(userDataDir, { recursive: true });
} catch (e) {
  console.error("mkdir failed:", e);
  process.exit(1);
}

const headless = process.env.STEAM_WORKER_HEADLESS === "1" || process.env.STEAM_WORKER_HEADLESS === "true";

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
    console.error("Chrome not found:", executablePath);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      type: "steam_worker_login_script",
      userDataDir,
      headless,
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
    timeout: 120_000,
  });

  console.log("Log in in the browser window, then close it or Ctrl+C.");

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
