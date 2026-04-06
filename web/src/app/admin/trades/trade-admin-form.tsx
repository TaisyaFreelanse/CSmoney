"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: "Ожидает" },
  { value: "accepted_by_admin", label: "Принято" },
  { value: "rejected", label: "Отклонено" },
  { value: "completed", label: "Завершено" },
  { value: "cancelled", label: "Отменено" },
];

export function TradeAdminForm({
  tradeId,
  initialStatus,
  initialNotes,
}: {
  tradeId: string;
  initialStatus: string;
  initialNotes: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function save() {
    setMessage(null);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/trades/${tradeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status, notes }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Ошибка ${res.status}`);
        return;
      }
      setMessage("Сохранено");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Действия</h3>
      <div className="mt-4 space-y-4">
        <div>
          <label
            htmlFor="trade-admin-status"
            className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            Статус
          </label>
          <select
            id="trade-admin-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full max-w-xs rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Заметка</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
            placeholder="Внутренняя заметка (видна только в админке)"
          />
        </div>
        {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        {message ? <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p> : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={loading}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {loading ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
    </div>
  );
}
