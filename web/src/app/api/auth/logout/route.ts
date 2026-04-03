import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/session";
import { publicSiteOrigin } from "@/lib/steam-openid";

function doLogout(request: NextRequest) {
  const base = publicSiteOrigin(request);
  const res = NextResponse.redirect(new URL("/", base), 303);
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

export async function GET(request: NextRequest) {
  return doLogout(request);
}

export async function POST(request: NextRequest) {
  return doLogout(request);
}
