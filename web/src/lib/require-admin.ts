import { getSessionUser } from "@/lib/auth";
import type { User } from "@prisma/client";

/** Session user with `isAdmin`; `null` if not signed in, banned, or not admin. */
export async function requireAdmin(): Promise<User | null> {
  const u = await getSessionUser();
  if (!u?.isAdmin) return null;
  return u;
}
