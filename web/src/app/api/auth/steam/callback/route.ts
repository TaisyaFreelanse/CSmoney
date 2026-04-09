import { NextRequest, NextResponse } from "next/server";

import { steamIdsGrantedAdminFromEnv } from "@/lib/admin-bootstrap";
import { prisma } from "@/lib/prisma";
import { fetchSteamPlayerSummary } from "@/lib/steam-profile";
import { SESSION_COOKIE_NAME, sessionCookieOptions, signSessionToken } from "@/lib/session";
import { publicSiteOrigin, verifySteamAssertion } from "@/lib/steam-openid";
import { queueTelegramNewUser } from "@/lib/telegram-notify";

export async function GET(request: NextRequest) {
  const base = publicSiteOrigin(request);

  const assertion = await verifySteamAssertion(request);
  if ("error" in assertion) {
    return NextResponse.redirect(new URL(`/?error=steam_${assertion.error}`, base));
  }

  const { steamId } = assertion;

  const existing = await prisma.user.findUnique({ where: { steamId } });
  if (existing?.isBanned) {
    return NextResponse.redirect(new URL("/?error=banned", base));
  }

  const summary = await fetchSteamPlayerSummary(steamId);
  const now = new Date();

  await prisma.user.upsert({
    where: { steamId },
    create: {
      steamId,
      displayName: summary.displayName,
      avatarUrl: summary.avatarUrl,
      lastLoginAt: now,
    },
    update: {
      displayName: summary.displayName ?? undefined,
      avatarUrl: summary.avatarUrl ?? undefined,
      lastLoginAt: now,
    },
  });

  if (!existing) {
    queueTelegramNewUser({
      steamId,
      displayName: summary.displayName,
    });
  }

  if (steamIdsGrantedAdminFromEnv().has(steamId)) {
    await prisma.user.update({
      where: { steamId },
      data: { isAdmin: true },
    });
  }

  let token: string;
  try {
    token = await signSessionToken(steamId);
  } catch {
    return NextResponse.redirect(new URL("/?error=session_config", base));
  }

  const res = NextResponse.redirect(new URL("/?signed_in=1", base));
  const opts = sessionCookieOptions();
  res.cookies.set(SESSION_COOKIE_NAME, token, opts);
  return res;
}
