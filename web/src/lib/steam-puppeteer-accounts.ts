import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";

import { normalizeSteamId64ForCache } from "./steam-community-url";

export type SteamPuppeteerAccount = {
  /** Stable id for gate lane + invalidation (SteamID64 when known). */
  laneId: string;
  /** Optional cookie header — legacy; omit when using userDataDir. */
  cookies?: string;
  /** Persistent Chromium profile directory (absolute path). */
  userDataDir?: string;
  /** Human id from config, e.g. acc1 (for logs). */
  accountId?: string;
  label?: string;
};

function parseCookieHeader(header: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

function trySteamId64FromSteamLoginSecureCookie(cookieHeader: string): string | null {
  const pairs = parseCookieHeader(cookieHeader);
  for (const p of pairs) {
    if (p.name.toLowerCase() !== "steamloginsecure") continue;
    try {
      const dec = decodeURIComponent(p.value);
      const first = dec.includes("||") ? dec.split("||")[0]!.trim() : dec.split("|")[0]!.trim();
      if (first && /^\d+$/.test(first)) return normalizeSteamId64ForCache(first);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Cooldown after Puppeteer transport errors (unchanged semantics). */
const INVALID_DEFAULT_MS = Math.max(
  60_000,
  parseInt(process.env.STEAM_PUPPETEER_ACCOUNT_INVALID_MS ?? "", 10) || 15 * 60 * 1000,
);

/** After N consecutive failures (any kind), use longer cooldown until a success. */
const CONSECUTIVE_FAIL_THRESHOLD = Math.max(
  2,
  Math.min(20, parseInt(process.env.STEAM_PUPPETEER_CONSECUTIVE_FAIL_THRESHOLD ?? "5", 10) || 5),
);

const INVALID_ESCALATED_MS = Math.max(
  30 * 60_000,
  parseInt(process.env.STEAM_PUPPETEER_ESCALATED_INVALID_MS ?? "", 10) || 2 * 60 * 60 * 1000,
);

/** Cooldown after detected dead Steam session (login wall, no trade UI). */
const PROFILE_SESSION_INVALID_MS = Math.max(
  5 * 60_000,
  Math.min(
    120 * 60_000,
    parseInt(process.env.STEAM_PROFILE_INVALID_MS ?? "", 10) || 20 * 60 * 1000,
  ),
);

let rr = 0;
const invalidUntil = new Map<string, number>();
/** laneId → reason for last profile invalidation (debug). */
const lastProfileInvalidReason = new Map<string, string>();
/** laneId → consecutive invalidations without a successful run. */
const consecutiveFailures = new Map<string, number>();

type ProfileMetrics = {
  firstUsedAt: number;
  lastSuccessAt: number;
  invalidationCount: number;
};

const profileMetrics = new Map<string, ProfileMetrics>();

function bumpMetricsInvalidation(laneId: string): void {
  const m = profileMetrics.get(laneId) ?? {
    firstUsedAt: Date.now(),
    lastSuccessAt: 0,
    invalidationCount: 0,
  };
  m.invalidationCount += 1;
  profileMetrics.set(laneId, m);
}

function ttlForLane(laneId: string, baseMs: number): number {
  const n = consecutiveFailures.get(laneId) ?? 0;
  return n >= CONSECUTIVE_FAIL_THRESHOLD ? INVALID_ESCALATED_MS : baseMs;
}

function accountUsable(laneId: string): boolean {
  const until = invalidUntil.get(laneId);
  if (until == null) return true;
  if (until <= Date.now()) {
    invalidUntil.delete(laneId);
    consecutiveFailures.delete(laneId);
    const reason = lastProfileInvalidReason.get(laneId);
    lastProfileInvalidReason.delete(laneId);
    console.log(
      JSON.stringify({
        type: "steam_profile_recovered",
        laneId,
        previousInvalidReason: reason ?? null,
        ts: Date.now(),
      }),
    );
    return true;
  }
  return false;
}

function resolveProfilesBaseDir(): string {
  const raw = process.env.STEAM_PUPPETEER_PROFILES_DIR?.trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  return path.resolve(process.cwd(), "profiles");
}

/**
 * Ensure parent dirs exist for persistent profiles (under {@link resolveProfilesBaseDir}).
 */
export function ensureUserDataDirReady(absPath: string): void {
  if (!absPath) return;
  try {
    mkdirSync(absPath, { recursive: true });
  } catch (e) {
    console.warn("[steam-puppeteer-accounts] mkdir userDataDir failed", absPath, e);
  }
}

/**
 * Absolute paths unchanged. Relative paths resolve under `profilesBase` (from
 * `STEAM_PUPPETEER_PROFILES_DIR`), not `process.cwd()`, so Render disk mounts work.
 * Legacy values like `profiles/acc_1` map to `{profilesBase}/acc_1` (no duplicate `profiles/`).
 */
function normalizeUserDataDirInput(raw: string, profilesBase: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (path.isAbsolute(t)) return t;
  let rel = t.replace(/^[.][/\\]/, "");
  const profilesPrefix = /^profiles[\\/]/i;
  if (profilesPrefix.test(rel)) {
    rel = rel.replace(profilesPrefix, "");
  }
  return path.resolve(profilesBase, rel);
}

/**
 * Public helper: same rules as `STEAM_PUPPETEER_ACCOUNTS_JSON` / `OWNER_USER_DATA_DIR` parsing.
 */
export function resolveSteamPuppeteerUserDataDir(raw: string): string {
  return normalizeUserDataDirInput(raw, resolveProfilesBaseDir());
}

function parseAccountsFromEnv(): SteamPuppeteerAccount[] {
  const profilesBase = resolveProfilesBaseDir();

  const rawJson = process.env.STEAM_PUPPETEER_ACCOUNTS_JSON?.trim();
  if (rawJson) {
    try {
      const arr = JSON.parse(rawJson) as unknown;
      if (!Array.isArray(arr)) return [];
      const out: SteamPuppeteerAccount[] = [];
      for (let i = 0; i < arr.length; i++) {
        const row = arr[i];
        if (!row || typeof row !== "object") continue;
        const o = row as Record<string, unknown>;
        const cookies = typeof o.cookies === "string" ? o.cookies.trim() : "";
        const userDataDirRaw = typeof o.userDataDir === "string" ? o.userDataDir.trim() : "";
        let userDataDir: string | undefined;
        if (userDataDirRaw) {
          userDataDir = normalizeUserDataDirInput(userDataDirRaw, profilesBase);
          ensureUserDataDirReady(userDataDir);
        }

        const accountId = typeof o.id === "string" ? o.id.trim() : undefined;

        const explicit =
          typeof o.steamId64 === "string"
            ? o.steamId64.trim()
            : typeof o.laneId === "string"
              ? o.laneId.trim()
              : typeof o.steamId === "string"
                ? o.steamId.trim()
                : "";

        const fromCookie = cookies ? trySteamId64FromSteamLoginSecureCookie(cookies) : null;

        const laneId = explicit
          ? normalizeSteamId64ForCache(explicit)
          : fromCookie ?? accountId ?? `acc_${i}`;

        if (!userDataDir && !cookies) continue;

        const label = typeof o.label === "string" ? o.label : undefined;
        out.push({
          laneId,
          ...(cookies ? { cookies } : {}),
          ...(userDataDir ? { userDataDir } : {}),
          ...(accountId ? { accountId } : {}),
          label,
        });
      }
      if (out.length > 0) return out;
    } catch (e) {
      console.warn("[steam-puppeteer-accounts] STEAM_PUPPETEER_ACCOUNTS_JSON parse failed", e);
    }
  }

  const single = process.env.STEAM_COMMUNITY_COOKIES?.trim();
  if (!single) return [];
  const laneId = trySteamId64FromSteamLoginSecureCookie(single) ?? "default";
  return [{ laneId, cookies: single, label: "default" }];
}

let cachedList: SteamPuppeteerAccount[] | null = null;

function listAccounts(): SteamPuppeteerAccount[] {
  if (!cachedList) cachedList = parseAccountsFromEnv();
  return cachedList;
}

/**
 * Temporarily remove a worker account after timeout / empty / guard-style failures.
 */
export function markGuestPuppeteerAccountInvalid(laneId: string, reason: string): void {
  const prev = consecutiveFailures.get(laneId) ?? 0;
  consecutiveFailures.set(laneId, prev + 1);
  bumpMetricsInvalidation(laneId);
  const ttl = ttlForLane(laneId, INVALID_DEFAULT_MS);
  invalidUntil.set(laneId, Date.now() + ttl);
  const m = profileMetrics.get(laneId);
  console.log(
    JSON.stringify({
      type: "steam_puppeteer_account",
      event: "invalidated",
      laneId,
      reason,
      consecutiveFailures: prev + 1,
      ttlMs: ttl,
      escalated: ttl > INVALID_DEFAULT_MS,
      until: new Date(invalidUntil.get(laneId)!).toISOString(),
      ts: Date.now(),
      invalidationCountTotal: m?.invalidationCount ?? 0,
    }),
  );
}

/**
 * Session in userDataDir is dead (login redirect, no trade UI). Cooldown {@link PROFILE_SESSION_INVALID_MS}.
 */
export function markGuestSteamProfileSessionInvalid(
  laneId: string,
  reason: string,
  accountId?: string,
): void {
  const prev = consecutiveFailures.get(laneId) ?? 0;
  consecutiveFailures.set(laneId, prev + 1);
  bumpMetricsInvalidation(laneId);
  const ttl = ttlForLane(laneId, PROFILE_SESSION_INVALID_MS);
  invalidUntil.set(laneId, Date.now() + ttl);
  lastProfileInvalidReason.set(laneId, reason);
  const m = profileMetrics.get(laneId);
  console.log(
    JSON.stringify({
      type: "steam_profile_invalid",
      laneId,
      accountId: accountId ?? null,
      reason,
      consecutiveFailures: prev + 1,
      ttlMs: ttl,
      escalated: ttl > PROFILE_SESSION_INVALID_MS,
      until: new Date(invalidUntil.get(laneId)!).toISOString(),
      ts: Date.now(),
      invalidationCountTotal: m?.invalidationCount ?? 0,
    }),
  );
}

/**
 * Call after a successful inventory load (Puppeteer path ok). Resets consecutive failure streak.
 */
export function recordSteamProfileSuccess(laneId: string, accountId?: string): void {
  consecutiveFailures.delete(laneId);
  const now = Date.now();
  const prev = profileMetrics.get(laneId);
  const firstUsedAt = prev?.firstUsedAt ?? now;
  const m: ProfileMetrics = {
    firstUsedAt,
    lastSuccessAt: now,
    invalidationCount: prev?.invalidationCount ?? 0,
  };
  profileMetrics.set(laneId, m);
  const sessionAgeMs = now - firstUsedAt;
  console.log(
    JSON.stringify({
      type: "steam_profile_metrics",
      event: "success",
      laneId,
      accountId: accountId ?? null,
      sessionAgeMs,
      lastSuccessAt: m.lastSuccessAt,
      invalidationCountTotal: m.invalidationCount,
      ts: now,
    }),
  );
}

/**
 * Round-robin next worker; skips entries in invalid cooldown. Returns null if no cookies configured.
 */
export function nextGuestPuppeteerAccount(): SteamPuppeteerAccount | null {
  const list = listAccounts();
  if (list.length === 0) return null;
  const usable = list.filter((a) => accountUsable(a.laneId));
  const pool = usable.length > 0 ? usable : list;
  const idx = rr++ % pool.length;
  const acc = pool[idx] ?? null;
  if (acc) {
    console.log(
      JSON.stringify({
        type: "steam_profile_used",
        acc_id: acc.accountId ?? acc.laneId,
        laneId: acc.laneId,
        mode: acc.userDataDir ? "userDataDir" : "cookies",
        ts: Date.now(),
      }),
    );
  }
  return acc;
}

export function guestPuppeteerAccountCount(): number {
  return listAccounts().length;
}

export function guestPuppeteerProfilesBaseDir(): string {
  return resolveProfilesBaseDir();
}

/**
 * Owner shop worker: `OWNER_USER_DATA_DIR`, or JSON entry with `"owner": true`, else `STEAM_COMMUNITY_COOKIES`.
 * Lane id = normalized OWNER_STEAM_ID (stable gate key).
 */
export function resolveOwnerPuppeteerAccount(): SteamPuppeteerAccount | null {
  const ownerId = process.env.OWNER_STEAM_ID?.trim();
  if (!ownerId) return null;
  const norm = normalizeSteamId64ForCache(ownerId);

  const dirEnv = process.env.OWNER_USER_DATA_DIR?.trim();
  if (dirEnv) {
    const abs = resolveSteamPuppeteerUserDataDir(dirEnv);
    ensureUserDataDirReady(abs);
    return { laneId: norm, userDataDir: abs, accountId: "owner", label: "owner" };
  }

  const rawJson = process.env.STEAM_PUPPETEER_ACCOUNTS_JSON?.trim();
  if (rawJson) {
    try {
      const arr = JSON.parse(rawJson) as unknown;
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          const row = arr[i];
          if (!row || typeof row !== "object") continue;
          const o = row as Record<string, unknown>;
          if (o.owner !== true) continue;
          const cookies = typeof o.cookies === "string" ? o.cookies.trim() : "";
          const userDataDirRaw = typeof o.userDataDir === "string" ? o.userDataDir.trim() : "";
          let userDataDir: string | undefined;
          if (userDataDirRaw) {
            userDataDir = normalizeUserDataDirInput(userDataDirRaw, resolveProfilesBaseDir());
            ensureUserDataDirReady(userDataDir);
          }
          const accountId = typeof o.id === "string" ? o.id.trim() : "owner";
          if (!userDataDir && !cookies) continue;
          return {
            laneId: norm,
            ...(cookies ? { cookies } : {}),
            ...(userDataDir ? { userDataDir } : {}),
            accountId,
            label: "owner",
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  const cookies = process.env.STEAM_COMMUNITY_COOKIES?.trim();
  if (cookies) {
    const fromCookie = trySteamId64FromSteamLoginSecureCookie(cookies);
    return {
      laneId: fromCookie ? normalizeSteamId64ForCache(fromCookie) : norm,
      cookies,
      accountId: "owner",
      label: "owner",
    };
  }

  return null;
}

let storageHintLogged = false;

/**
 * Warn once on Render if profiles may be ephemeral (no mounted disk path).
 */
export function logSteamProfilesStorageHint(): void {
  if (storageHintLogged) return;
  storageHintLogged = true;
  const base = resolveProfilesBaseDir();
  const onRender = process.env.RENDER === "true";
  const explicit = Boolean(process.env.STEAM_PUPPETEER_PROFILES_DIR?.trim());
  const suspicious =
    onRender &&
    !explicit &&
    (base.includes("tmp") || base.includes("/var") || base === path.resolve(process.cwd(), "profiles"));
  console.log(
    JSON.stringify({
      type: "steam_profiles_storage",
      profilesBaseDir: base,
      onRender,
      explicitProfilesDir: explicit,
      hint: suspicious
        ? "Set STEAM_PUPPETEER_PROFILES_DIR to a Render persistent disk mount or sessions reset on deploy."
        : explicit
          ? "Profiles directory set explicitly — ensure the mount is persistent."
          : "Using default ./profiles under app cwd; on PaaS use a persistent volume for STEAM_PUPPETEER_PROFILES_DIR.",
      ts: Date.now(),
    }),
  );
}
