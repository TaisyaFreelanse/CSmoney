import type { NextRequest } from "next/server";

/**
 * Canonical public origin from NEXT_PUBLIC_APP_URL (used for session + Steam callbacks).
 */
export function canonicalOriginFromEnv(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Lowercase hostnames (no port) that should 308 to NEXT_PUBLIC_APP_URL (canonical). */
export function siteHostAliasSet(): Set<string> {
  const raw = process.env.SITE_HOST_ALIASES ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * If the request hits an alias host, same path/query should be served on the canonical host
 * so the session cookie (scoped to one host) is consistent.
 */
export function canonicalAliasRedirect(request: NextRequest): URL | null {
  if (process.env.NODE_ENV !== "production") return null;

  const canonical = canonicalOriginFromEnv();
  if (!canonical) return null;

  let canonicalHost: string;
  try {
    canonicalHost = new URL(canonical).hostname.toLowerCase();
  } catch {
    return null;
  }

  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase();
  if (!host || host === canonicalHost) return null;

  const aliases = siteHostAliasSet();
  if (!aliases.has(host)) return null;

  return new URL(request.nextUrl.pathname + request.nextUrl.search, canonical);
}
