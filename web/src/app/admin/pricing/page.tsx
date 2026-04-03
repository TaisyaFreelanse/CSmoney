"use client";

import { useCallback, useEffect, useState } from "react";

interface PricingSettings {
  selectedPriceProvider: string;
  markupGuestPercent: number;
  markupOwnerPercent: number;
  minPriceThresholdUsd: number;
}

interface ManualPrice {
  id: string;
  assetId: string;
  priceUsd: string;
  note: string | null;
  setAt: string;
}

const PROVIDERS = [
  { key: "buff163", label: "Buff163 (Starting At)" },
  { key: "skins", label: "Skins.com" },
];

export default function AdminPricingPage() {
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [manualPrices, setManualPrices] = useState<ManualPrice[]>([]);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");
  const [newAssetId, setNewAssetId] = useState("");
  const [newPriceUsd, setNewPriceUsd] = useState("");
  const [newNote, setNewNote] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/pricing");
    if (res.ok) {
      const data = await res.json();
      setSettings(data.settings);
      setManualPrices(data.manualPrices ?? []);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    setMsg("");
    const res = await fetch("/api/admin/pricing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (res.ok) {
      setMsg("Сохранено");
      load();
    } else {
      setMsg("Ошибка сохранения");
    }
    setSaving(false);
  }

  async function handleSync() {
    setSyncing(true);
    setMsg("");
    const res = await fetch("/api/prices/sync");
    if (res.ok) {
      const data = await res.json();
      setMsg(`Синхронизировано: ${data.upserted} цен за ${data.elapsedMs}ms`);
    } else {
      setMsg("Ошибка синхронизации");
    }
    setSyncing(false);
  }

  async function handleAddManual() {
    if (!newAssetId.trim() || !newPriceUsd.trim()) return;
    const res = await fetch("/api/admin/pricing/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: newAssetId.trim(),
        priceUsd: parseFloat(newPriceUsd),
        note: newNote.trim() || null,
      }),
    });
    if (res.ok) {
      setNewAssetId("");
      setNewPriceUsd("");
      setNewNote("");
      load();
    }
  }

  async function handleDeleteManual(assetId: string) {
    await fetch("/api/admin/pricing/manual", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId }),
    });
    load();
  }

  if (!settings) {
    return <p className="text-sm text-zinc-500">Загрузка...</p>;
  }

  const input =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Настройки цен
        </h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Провайдер цен
            </span>
            <select
              className={input}
              value={settings.selectedPriceProvider}
              onChange={(e) =>
                setSettings({ ...settings, selectedPriceProvider: e.target.value })
              }
            >
              {PROVIDERS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Мин. порог цены (USD)
            </span>
            <input
              type="number"
              step="1"
              className={input}
              value={settings.minPriceThresholdUsd}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  minPriceThresholdUsd: parseFloat(e.target.value) || 0,
                })
              }
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Наценка на предметы гостя (%)
            </span>
            <input
              type="number"
              step="0.1"
              className={input}
              value={settings.markupGuestPercent}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  markupGuestPercent: parseFloat(e.target.value) || 0,
                })
              }
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Наценка на мои предметы (%)
            </span>
            <input
              type="number"
              step="0.1"
              className={input}
              value={settings.markupOwnerPercent}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  markupOwnerPercent: parseFloat(e.target.value) || 0,
                })
              }
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {syncing ? "Синхронизация..." : "Синхронизировать цены"}
          </button>
        </div>

        {msg && (
          <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
            {msg}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Ручные цены (мои предметы)
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Привязка по assetId. Ручная цена приоритетнее каталога и снимает &quot;UNAVAILABLE&quot;.
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-4">
          <input
            placeholder="assetId"
            className={input}
            value={newAssetId}
            onChange={(e) => setNewAssetId(e.target.value)}
          />
          <input
            placeholder="Цена USD"
            type="number"
            step="0.01"
            className={input}
            value={newPriceUsd}
            onChange={(e) => setNewPriceUsd(e.target.value)}
          />
          <input
            placeholder="Заметка (опц.)"
            className={input}
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
          />
          <button
            onClick={handleAddManual}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Добавить
          </button>
        </div>

        {manualPrices.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500 dark:border-zinc-700">
                  <th className="pb-2 pr-4">Asset ID</th>
                  <th className="pb-2 pr-4">Цена USD</th>
                  <th className="pb-2 pr-4">Заметка</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {manualPrices.map((mp) => (
                  <tr
                    key={mp.id}
                    className="border-b border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                      {mp.assetId}
                    </td>
                    <td className="py-2 pr-4 text-zinc-900 dark:text-zinc-100">
                      ${Number(mp.priceUsd).toFixed(2)}
                    </td>
                    <td className="py-2 pr-4 text-zinc-500">{mp.note ?? "—"}</td>
                    <td className="py-2">
                      <button
                        onClick={() => handleDeleteManual(mp.assetId)}
                        className="text-xs text-red-600 hover:text-red-800 dark:text-red-400"
                      >
                        Сброс
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
