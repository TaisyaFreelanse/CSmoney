#!/usr/bin/env node
/**
 * Batch GET /inventory on local steam-worker and aggregate float coverage from `raw` (merged JSON).
 *
 * Usage (on VPS, from steam-worker dir):
 *   node --env-file=.env scripts/audit-trade-float-batch.mjs
 *   node --env-file=.env scripts/audit-trade-float-batch.mjs "URL1" "URL2"
 *
 * Env:
 *   TRADE_AUDIT_URLS — comma-separated trade URLs (optional; else defaults + argv)
 *   PORT — default 3001
 *   API_KEY — x-api-key if worker requires it
 */
import { auditSteamTradeRaw } from "../src/utils/inventoryFloatAudit.js";

/** Репозиторий содержит только пару тестовых ссылок; для 5–10 инвентарей задайте `TRADE_AUDIT_URLS` или аргументы CLI. */
const DEFAULT_URLS = [
  "https://steamcommunity.com/tradeoffer/new/?partner=344919981&token=s3lHfh8l",
  "https://steamcommunity.com/tradeoffer/new/?partner=351815157&token=MPDBjSrY",
];

function parseUrlList() {
  const fromEnv = process.env.TRADE_AUDIT_URLS?.trim();
  const argv = process.argv.slice(2).filter(Boolean);
  if (argv.length > 0) return argv;
  if (fromEnv) {
    return fromEnv
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_URLS;
}

const urls = parseUrlList();
const port = Number(process.env.PORT) || 3001;
const base = `http://127.0.0.1:${port}`;
const apiKey = process.env.API_KEY?.trim();

async function fetchInventory(tradeUrl) {
  const u = new URL("/inventory", base);
  u.searchParams.set("tradeUrl", tradeUrl);
  const headers = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(u, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const perTrade = [];

for (const tradeUrl of urls) {
  const { status, body } = await fetchInventory(tradeUrl);
  if (status !== 200 || !body?.raw || typeof body.raw !== "object") {
    perTrade.push({
      tradeUrl: tradeUrl.slice(0, 96),
      httpStatus: status,
      error: body?.error ?? "no_raw",
      audit: null,
    });
    continue;
  }
  const audit = auditSteamTradeRaw(body.raw);
  perTrade.push({
    tradeUrl: tradeUrl.slice(0, 120),
    httpStatus: status,
    itemCountWorker: Array.isArray(body.items) ? body.items.length : null,
    audit,
  });
  await new Promise((r) => setTimeout(r, 800));
}

const okRows = perTrade.filter((p) => p.audit && p.audit.total > 0);
let sumTotal = 0;
let sumFloatRg = 0;
let sumFloatMerged = 0;
let sumNoMerged = 0;
let sumDoppler = 0;
let sumDopplerPhase = 0;
for (const p of okRows) {
  const a = p.audit;
  sumTotal += a.total;
  sumFloatRg += a.withFloatSteam;
  sumFloatMerged += a.withFloatMergedSources;
  sumNoMerged += a.withoutFloatMergedSources;
  sumDoppler += a.dopplerFamilyItemCount;
  sumDopplerPhase += a.dopplerWithPhaseFromPid7 + a.dopplerWithPhaseFromPid6IntHint;
}

const summary = {
  tradesRequested: urls.length,
  tradesWithAudit: okRows.length,
  totalItems: sumTotal,
  totalAvg: okRows.length > 0 ? sumTotal / okRows.length : 0,
  percentWithFloatSteam: sumTotal > 0 ? (100 * sumFloatRg) / sumTotal : 0,
  percentWithoutFloatMerged: sumTotal > 0 ? (100 * sumNoMerged) / sumTotal : 0,
  percentWithFloatMerged: sumTotal > 0 ? (100 * sumFloatMerged) / sumTotal : 0,
  dopplerItemCount: sumDoppler,
  dopplerWithPhaseCount: sumDopplerPhase,
};

const out = { summary, perTrade };
// eslint-disable-next-line no-console
console.log(JSON.stringify(out, null, 2));
