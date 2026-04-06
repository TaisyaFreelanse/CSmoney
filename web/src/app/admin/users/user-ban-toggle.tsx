"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UserBanToggle({
  steamId,
  isBanned,
  currentAdminSteamId,
}: {
  steamId: string;
  isBanned: boolean;
  currentAdminSteamId: string;
}) {
  const router = useRouter();
  const [banned, setBanned] = useState(isBanned);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSelf = steamId === currentAdminSteamId;

  async function setBan(next: boolean) {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(steamId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isBanned: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error === "cannot_ban_self" ? "Нельзя заблокировать себя" : data?.error ?? res.statusText);
        return;
      }
      setBanned(next);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (isSelf) {
    return <span className="text-xs text-zinc-500">—</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
      {banned ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void setBan(false)}
          className="rounded-lg border border-emerald-600/50 bg-emerald-600/10 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-600/20 disabled:opacity-40 dark:text-emerald-300"
        >
          {loading ? "…" : "Разбанить"}
        </button>
      ) : (
        <button
          type="button"
          disabled={loading}
          onClick={() => void setBan(true)}
          className="rounded-lg border border-red-600/50 bg-red-600/10 px-3 py-1 text-xs font-medium text-red-800 hover:bg-red-600/20 dark:text-red-300"
        >
          {loading ? "…" : "Забанить"}
        </button>
      )}
    </div>
  );
}
