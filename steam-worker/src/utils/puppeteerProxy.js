import { logJson } from "./logger.js";

export function puppeteerHeadless() {
  const v = process.env.STEAM_WORKER_HEADLESS;
  return v === "1" || v === "true";
}

/**
 * Bright Data ISP sticky session per Steam account (same IP for login + worker).
 * PROXY_USERNAME in .env = base without session, e.g. brd-customer-xxx-zone-isp_proxy1
 * → authenticates as ...-session-acc1 for accountId acc1.
 * Set PROXY_STICKY_SESSION=0 to use PROXY_USERNAME exactly.
 * Placeholder: ...{accountId}... in PROXY_USERNAME is replaced by id.
 */
export function proxyAuthForAccount(accountId) {
  const rawUser = process.env.PROXY_USERNAME?.trim();
  const password = process.env.PROXY_PASSWORD;
  if (rawUser == null || password == null) return null;
  const pass = String(password);
  const stickyOff =
    process.env.PROXY_STICKY_SESSION === "0" || process.env.PROXY_STICKY_SESSION === "false";
  if (stickyOff) {
    return { username: rawUser, password: pass };
  }
  const id = String(accountId ?? "default")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64) || "default";
  if (rawUser.includes("{accountId}")) {
    return { username: rawUser.replace(/\{accountId\}/g, id), password: pass };
  }
  if (/-session-[A-Za-z0-9_-]+$/.test(rawUser)) {
    return { username: rawUser, password: pass };
  }
  return { username: `${rawUser}-session-${id}`, password: pass };
}

/** @param {string[]} extra */
export function puppeteerChromeArgs(extra = []) {
  const args = ["--no-sandbox", "--disable-setuid-sandbox", ...extra];
  const host = process.env.PROXY_HOST?.trim();
  const port = process.env.PROXY_PORT?.trim();
  if (host && port) {
    args.push(`--proxy-server=http://${host}:${port}`);
    args.push("--ignore-certificate-errors");
  }
  return args;
}

/** After authenticate; logs egress IP when STEAM_WORKER_VERIFY_PROXY_IP=1 */
export async function verifyBrightDataProxyIp(page, accountId) {
  const host = process.env.PROXY_HOST?.trim();
  if (!host || process.env.STEAM_WORKER_VERIFY_PROXY_IP !== "1") return;
  try {
    await page.goto("https://geo.brdtest.com/mygeo.json", {
      waitUntil: "domcontentloaded",
      timeout: 18_000,
    });
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    let ip = null;
    try {
      const j = JSON.parse(text);
      ip = j.ip ?? j.ipv4 ?? j.client_ip ?? j.clientIp ?? null;
    } catch {
      /* not JSON */
    }
    logJson("steam_worker_proxy_ip_verify", {
      accountId,
      ip,
      bodyPreview: text.length > 600 ? text.slice(0, 600) : text,
    });
  } catch (e) {
    logJson("steam_worker_proxy_ip_verify", {
      accountId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function authenticatePuppeteerProxy(page, accountId) {
  const auth = proxyAuthForAccount(accountId);
  if (!auth) return;
  await page.authenticate({ username: auth.username, password: auth.password });
}
