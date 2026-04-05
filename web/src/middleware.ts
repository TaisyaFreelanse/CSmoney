import { type NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

import { SESSION_COOKIE_NAME } from "@/lib/session";
import { canonicalAliasRedirect } from "@/lib/site-canonical";

function jwtSecret(): Uint8Array | null {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) return null;
  return new TextEncoder().encode(s);
}

export async function middleware(request: NextRequest) {
  const aliasTarget = canonicalAliasRedirect(request);
  if (aliasTarget) {
    return NextResponse.redirect(aliasTarget, 308);
  }

  if (!request.nextUrl.pathname.startsWith("/admin")) {
    return NextResponse.next();
  }

  const secret = jwtSecret();
  if (!secret) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  try {
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/", request.url));
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
