#!/usr/bin/env node
/**
 * Диагностика steam-worker: прокси (Bright Data), /health, опционально GET /inventory.
 * Не меняет бизнес-логику сервера — только HTTP-проверки и сводка по process.env.
 *
 * Запуск на VPS из каталога steam-worker (подхватит .env из cwd):
 *   node scripts/diagnose-inventory-proxy.mjs
 *   node scripts/diagnose-inventory-proxy.mjs http://127.0.0.1:3001
 *
 * Для проверки /inventory без вывода URL в лог CI — задайте в .env:
 *   STEAM_DIAGNOSTIC_TRADE_URL=https://steamcommunity.com/tradeoffer/new/?partner=...&token=...
 * Или одноразово:
 *   STEAM_DIAGNOSTIC_TRADE_URL='...' node scripts/diagnose-inventory-proxy.mjs
 */

import fs from "node:fs";
import path from "node:path";

const baseArg = process.argv[2]?.startsWith("http") ? process.argv[2] : null;
const base = (baseArg ?? "http://127.0.0.1:3001").replace(/\/$/, "");

function loadDotEnv(cwd) {
  const p = path.join(cwd, ".env");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function mask(v) {
  if (v == null || v === "") return "(empty)";
  const t = String(v);
  if (t.length <= 4) return "***";
  return `${t.slice(0, 2)}…${t.slice(-2)} (${t.length} chars)`;
}

function proxySummary() {
  const host = process.env.PROXY_HOST?.trim() ?? "";
  const port = process.env.PROXY_PORT?.trim() ?? "";
  const user = process.env.PROXY_USERNAME?.trim() ?? "";
  const pass = process.env.PROXY_PASSWORD;
  const partial =
    (!!host !== !!port) || (host && port && (!user || pass == null || pass === ""));
  return {
    PROXY_HOST: host ? "set" : "(empty)",
    PROXY_PORT: port || "(empty)",
    PROXY_USERNAME: user ? `set ${mask(user)}` : "(empty)",
    PROXY_PASSWORD: pass != null && pass !== "" ? "set" : "(empty)",
    proxyChromeEnabled: !!(host && port),
    proxyAuthWouldRun: !!(user && pass != null && pass !== ""),
    partialMisconfig: partial,
  };
}

async function fetchText(url, headers = {}) {
  const ac = AbortSignal.timeout(120_000);
  const res = await fetch(url, { headers, signal: ac });
  const text = await res.text();
  return { res, text };
}

async function main() {
  const cwd = process.cwd();
  loadDotEnv(cwd);

  console.log("=== steam-worker diagnose (inventory / proxy) ===\n");
  console.log("cwd:", cwd);
  console.log("base URL:", base);
  console.log("proxy:", JSON.stringify(proxySummary(), null, 2));
  if (proxySummary().partialMisconfig) {
    console.warn(
      "\n[WARN] PROXY_* частично задан: задайте все четыре (HOST, PORT, USERNAME, PASSWORD) или оставьте все пустыми для режима без прокси.\n",
    );
  }

  const verify = process.env.STEAM_WORKER_VERIFY_PROXY_IP === "1";
  console.log("STEAM_WORKER_VERIFY_PROXY_IP:", verify ? "1 (логи steam_worker_proxy_ip_verify при следующем /inventory)" : "off");

  console.log("\n--- GET /health ---");
  try {
    const { res, text } = await fetchText(`${base}/health`);
    console.log("status:", res.status);
    console.log("body:", text.slice(0, 500));
  } catch (e) {
    console.error("/health failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }

  const apiKey = process.env.API_KEY?.trim();
  const tradeUrl =
    process.env.STEAM_DIAGNOSTIC_TRADE_URL?.trim() ||
    process.env.DIAGNOSTIC_TRADE_URL?.trim() ||
    "";

  if (!apiKey) {
    console.log("\n[skip] API_KEY не задан — /inventory не вызываем.");
    console.log("Добавьте в .env API_KEY и STEAM_DIAGNOSTIC_TRADE_URL для полного теста.");
    return;
  }
  if (!tradeUrl) {
    console.log("\n[skip] STEAM_DIAGNOSTIC_TRADE_URL не задан — /inventory не вызываем.");
    return;
  }

  const u = new URL(`${base}/inventory`);
  u.searchParams.set("tradeUrl", tradeUrl);

  console.log("\n--- GET /inventory (diagnostic trade URL) ---");
  try {
    const { res, text } = await fetchText(u.toString(), {
      "x-api-key": apiKey,
      Accept: "application/json",
    });
    console.log("status:", res.status);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.log("body (raw):", text.slice(0, 800));
      process.exitCode = 1;
      return;
    }
    const err = body.error ?? null;
    const n = Array.isArray(body.items) ? body.items.length : 0;
    console.log("items.length:", n);
    console.log("error:", err);
    console.log("sessionInvalid (meta):", body.meta?.tradeOutcome?.sessionInvalid ?? body.sessionInvalid ?? "(n/a)");
    if (err && err !== null) {
      console.log("detail (tradeOutcome):", body.meta?.tradeOutcome?.detail ?? "(n/a)");
      process.exitCode = err === "proxy_error" || err === "puppeteer_error" ? 2 : 1;
    } else {
      console.log("OK: error is null, inventory returned.");
    }
  } catch (e) {
    console.error("/inventory failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }

  console.log("\n--- Steam reachability (curl-like, server egress) ---");
  try {
    const { res, text } = await fetchText("https://steamcommunity.com/", {
      "User-Agent":
        "Mozilla/5.0 (compatible; CSmoney-steam-worker-diagnose/1.0; +https://example.invalid)",
    });
    console.log("GET https://steamcommunity.com/ status:", res.status, "bytes:", text.length);
  } catch (e) {
    console.warn("steamcommunity.com fetch:", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
