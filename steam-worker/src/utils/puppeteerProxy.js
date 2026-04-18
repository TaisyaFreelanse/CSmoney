export function puppeteerHeadless() {
  return process.env.STEAM_WORKER_HEADLESS !== "0";
}

/** @param {string[]} extra */
export function puppeteerChromeArgs(extra = []) {
  const args = ["--no-sandbox", "--disable-setuid-sandbox", ...extra];
  const host = process.env.PROXY_HOST?.trim();
  const port = process.env.PROXY_PORT?.trim();
  if (host && port) {
    args.push(`--proxy-server=http://${host}:${port}`);
  }
  return args;
}

export async function authenticatePuppeteerProxy(page) {
  const username = process.env.PROXY_USERNAME?.trim();
  const password = process.env.PROXY_PASSWORD;
  if (username == null || password == null) return;
  await page.authenticate({ username, password: String(password) });
}
