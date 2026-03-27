import type { NextRequest } from "next/server";

const STEAM_OPENID = "https://steamcommunity.com/openid/login";

function isLocalhostOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function originFromForwardedHeaders(request: NextRequest): string | null {
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (!host) return null;
  const p = proto === "http" || proto === "https" ? proto : "https";
  return `${p}://${host}`;
}

/**
 * Публичный origin сайта (Steam return_to, редиректы после входа).
 * В production не использует NEXT_PUBLIC_APP_URL, если там localhost — типичная ошибка на Render.
 */
export function publicSiteOrigin(request: NextRequest): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const renderUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
  const forwarded = originFromForwardedHeaders(request);

  if (process.env.NODE_ENV === "production") {
    if (envUrl && !isLocalhostOrigin(envUrl)) return envUrl;
    if (forwarded) return forwarded;
    if (renderUrl) return renderUrl;
  } else {
    if (envUrl) return envUrl;
    if (forwarded) return forwarded;
    if (renderUrl) return renderUrl;
  }

  return new URL(request.url).origin;
}

/** Alias для OpenID realm / return_to. */
export function steamOpenIdOrigin(request: NextRequest): string {
  return publicSiteOrigin(request);
}

export function steamLoginRedirectUrl(request: NextRequest): string {
  const origin = steamOpenIdOrigin(request);
  const returnTo = `${origin}/api/auth/steam/callback`;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `${STEAM_OPENID}?${params.toString()}`;
}

/**
 * Validate Steam OpenID callback: POST all openid.* params back with mode check_authentication.
 */
export async function verifySteamAssertion(
  request: NextRequest,
): Promise<{ steamId: string } | { error: string }> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("openid.mode");
  if (mode !== "id_res") {
    return { error: "invalid_mode" };
  }

  const body = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (key.startsWith("openid.")) {
      body.append(key, value);
    }
  });
  body.set("openid.mode", "check_authentication");

  const res = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!text.includes("is_valid:true")) {
    return { error: "not_valid" };
  }

  const claimed = url.searchParams.get("openid.claimed_id");
  if (!claimed) return { error: "no_claimed_id" };

  const m = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/.exec(claimed);
  if (!m) return { error: "bad_claimed_id" };

  return { steamId: m[1] };
}
