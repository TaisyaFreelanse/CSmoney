/** Steam ID64 из ADMIN_STEAM_IDS (через запятую) — при входе выставляется isAdmin. Только прод-конфиг, не коммитьте реальные ID. */
export function steamIdsGrantedAdminFromEnv(): Set<string> {
  const raw = process.env.ADMIN_STEAM_IDS;
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d{17}$/.test(s)),
  );
}
