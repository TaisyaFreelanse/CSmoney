#!/usr/bin/env node
/**
 * Manual Steam login into a persistent userDataDir.
 * Usage: npm run login -- acc1
 * Requires STEAM_ACCOUNTS in env (or pass profile path as only arg for quick login).
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  authenticatePuppeteerProxy,
  puppeteerChromeArgs,
  puppeteerHeadless,
  verifyBrightDataProxyIp,
} from "../src/utils/puppeteerProxy.js";

const arg = process.argv[2]?.trim();
if (!arg) {
  console.error(
    "Usage: npm run login -- <accountId|path-to-profile>\n" +
      "Пример для двух ботов: npm run login -- acc1   и отдельно   npm run login -- acc2\n" +
      "У каждого id в STEAM_ACCOUNTS должен быть свой userDataDir — иначе в одном профиле окажется последний залогиненный Steam.\n" +
      "На VPS с VNC: npm run login:vps -- acc1",
  );
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
const proxySessionKey = /[/\\]/.test(arg) ? path.basename(userDataDir) : arg;

try {
  mkdirSync(userDataDir, { recursive: true });
} catch (e) {
  console.error("mkdir failed:", e);
  process.exit(1);
}

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

  const headless = puppeteerHeadless();
  console.log(
    JSON.stringify({
      type: "steam_worker_login_script",
      userDataDir,
      headless,
    }),
  );

  let browser;
  try {
    browser = await pp.launch({
      headless,
      userDataDir,
      ...(executablePath ? { executablePath } : {}),
      args: puppeteerChromeArgs(["--disable-dev-shm-usage"]),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Missing X server|X server/i.test(msg) && !headless) {
      console.error(
        "\n[steam-worker login] Headful Chrome needs X11: DISPLAY + cookie file (export XAUTHORITY=~/.Xauthority if missing).\n" +
          "Open Terminal inside the VNC desktop (same user as the desktop session), then: npm run login:vps -- acc1\n" +
          "Or use headless / copy profile from PC: STEAM_WORKER_HEADLESS=1 npm run login -- acc1\n",
      );
    }
    throw e;
  }

  const page = await browser.newPage();
  await authenticatePuppeteerProxy(page, proxySessionKey);
  await verifyBrightDataProxyIp(page, proxySessionKey);
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
