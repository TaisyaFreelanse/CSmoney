#!/usr/bin/env node
/**
 * Проверка: M9 Bayonet | Gamma Doppler (FN) в трейдлоке — в itemsFromTradeLock, float ~0.0285, paint 570.
 *
 *   cd steam-worker && node --env-file=.env scripts/verify-m9-gamma-trade-lock.mjs [tradeUrl]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, "utf8");
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

const tradeUrl =
  process.argv[2]?.trim() ||
  process.env.TRADE_VERIFY_URL?.trim() ||
  "https://steamcommunity.com/tradeoffer/new/?partner=344919981&token=s3lHfh8l";

const port = Number(process.env.PORT) || 3001;
const apiKey = process.env.API_KEY?.trim();
const base = `http://127.0.0.1:${port}`;

function matchesM9GammaDoppler(row) {
  const a = String(row?.market_hash_name ?? row?.name ?? "");
  return /m9 bayonet.*gamma doppler|gamma doppler.*m9 bayonet/i.test(a);
}

/** Тест-кейс: конкретный FN в трейдлоке с float ~0.0285 (не другой M9 Gamma в инвентаре). */
function matchesTradeLockCase(row) {
  if (!matchesM9GammaDoppler(row)) return false;
  const f = Number(row?.floatValue);
  if (!Number.isFinite(f)) return false;
  return Math.abs(f - 0.0285) < 0.002;
}

function pick(arr) {
  if (!Array.isArray(arr)) return null;
  const byAsset = process.env.TARGET_ASSET_ID?.trim();
  if (byAsset) {
    const hit = (arr || []).find((r) => String(r?.assetid) === byAsset);
    if (hit) return hit;
    return null;
  }
  return (arr || []).find(matchesTradeLockCase) ?? null;
}

const u = new URL("/inventory", base);
u.searchParams.set("tradeUrl", tradeUrl);
const headers = {};
if (apiKey) headers["x-api-key"] = apiKey;

const res = await fetch(u, { headers });
const j = await res.json().catch(() => ({}));

if (!res.ok || j.error) {
  console.log(JSON.stringify({ verdict: "FAIL", reason: "http_or_worker_error", status: res.status, error: j.error ?? null }, null, 2));
  process.exit(1);
}

const byAsset = process.env.TARGET_ASSET_ID?.trim();
const main = pick(j.mainItems);
const lock = pick(j.itemsFromTradeLock);
const any = pick(j.items);

const allM9Gamma = (j.items || []).filter(matchesM9GammaDoppler);

if (byAsset && !any) {
  console.log(
    JSON.stringify(
      {
        verdict: "FAIL",
        reason: "TARGET_ASSET_ID_not_in_inventory_response",
        hint: "Укажите tradeUrl того аккаунта, где предмет реально в partnerinventory (тот же partner/token).",
        tradeUrl: tradeUrl.slice(0, 120),
        TARGET_ASSET_ID: byAsset,
        itemCount: j.items?.length ?? 0,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const floatOk = (v) => v != null && Math.abs(Number(v) - 0.0285) < 0.002;
const paintOk = (v) => Number(v) === 570;
const hexOk = (h) => typeof h === "string" && /^[0-9A-F]{40,}$/i.test(h.trim());

let verdict = "FAIL";
let reason = "";

if (!lock && !main && !any) {
  reason = allM9Gamma.length ? "no_m9_gamma_with_float_~0.0285_use_TARGET_ASSET_ID" : "item_not_found";
} else if (main && !lock) {
  reason = "in_mainItems_not_trade_lock_list_or_wrong_float_filter";
} else if (lock) {
  if (!floatOk(lock.floatValue)) reason = `float_mismatch got=${lock.floatValue}`;
  else if (!paintOk(lock.paintIndex)) reason = `paintIndex_expected_570 got=${lock.paintIndex}`;
  else if (!hexOk(lock.inspectHex ?? "")) reason = "missing_or_invalid_inspectHex";
  else verdict = "OK";
}

console.log(
  JSON.stringify(
    {
      verdict,
      reason: verdict === "OK" ? null : reason,
      tradeUrl: tradeUrl.slice(0, 96),
      found: { mainItems: !!main, itemsFromTradeLock: !!lock, items: !!any },
      lockRow: lock
        ? {
            assetid: lock.assetid,
            market_hash_name: lock.market_hash_name,
            name: lock.name,
            tradable: lock.tradable,
            inTradeHold: lock.inTradeHold,
            tradeLockUntil: lock.tradeLockUntil,
            floatValue: lock.floatValue,
            floatSource: lock.floatSource,
            paintIndex: lock.paintIndex,
            phaseLabel: lock.phaseLabel,
            inspectHexPrefix: lock.inspectHex ? String(lock.inspectHex).slice(0, 20) + "…" : null,
          }
        : null,
      mainRowBrief: main
        ? { assetid: main.assetid, floatValue: main.floatValue, tradable: main.tradable }
        : null,
      m9GammaCandidates: allM9Gamma.map((r) => ({
        assetid: r.assetid,
        floatValue: r.floatValue,
        tradable: r.tradable,
        paintIndex: r.paintIndex,
        inLock: (j.itemsFromTradeLock || []).some((x) => String(x.assetid) === String(r.assetid)),
      })),
    },
    null,
    2,
  ),
);

process.exit(verdict === "OK" ? 0 : 1);
