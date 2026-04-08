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
  mode: string;
  priceUsd: string | null;
  markupPercent: number | null;
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
  const [newManualMode, setNewManualMode] = useState<"fixed" | "markup_percent">("fixed");
  const [newPriceUsd, setNewPriceUsd] = useState("");
  const [newMarkupPercent, setNewMarkupPercent] = useState("");
  const [newNote, setNewNote] = useState("");
  const [copyHint, setCopyHint] = useState("");

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

  async function pasteAssetIdFromClipboard() {
    setCopyHint("");
    try {
      const t = await navigator.clipboard.readText();
      if (t?.trim()) setNewAssetId(t.trim());
      else setCopyHint("Буфер пуст");
    } catch {
      setCopyHint("Нет доступа к буферу");
    }
  }

  async function copyToClipboard(text: string) {
    setCopyHint("");
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint(`Скопировано: ${text.slice(0, 12)}…`);
      window.setTimeout(() => setCopyHint(""), 2000);
    } catch {
      setCopyHint("Не удалось скопировать");
    }
  }

  async function handleAddManual() {
    if (!newAssetId.trim()) return;
    const body: Record<string, unknown> = {
      assetId: newAssetId.trim(),
      mode: newManualMode,
      note: newNote.trim() || null,
    };
    if (newManualMode === "fixed") {
      const p = parseFloat(newPriceUsd);
      if (!Number.isFinite(p) || p <= 0) return;
      body.priceUsd = p;
    } else {
      const m = parseFloat(newMarkupPercent);
      if (!Number.isFinite(m)) return;
      body.markupPercent = m;
    }
    const res = await fetch("/api/admin/pricing/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setNewAssetId("");
      setNewPriceUsd("");
      setNewMarkupPercent("");
      setNewNote("");
      setMsg("Правило сохранено");
      load();
    } else {
      const err = await res.json().catch(() => null);
      setMsg(err?.error ?? "Ошибка сохранения ручной цены");
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
              Скидка от базы для пользователя (левая колонка, %)
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
            <span className="mt-0.5 block text-[10px] text-zinc-400">
              Цена гостя = база × (1 − % / 100). Пример: база $100, 3.5% → $96.50
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Наценка магазина (правая колонка, %)
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
            <span className="mt-0.5 block text-[10px] text-zinc-400">
              Цена магазина = база × (1 + % / 100). Пример: база $100, 8.5% → $108.50
            </span>
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
          Привязка по <strong className="text-zinc-600 dark:text-zinc-400">assetId</strong> (на главной в инвентаре магазина под карточкой виден ID и кнопка «Копир.» для админа). При сохранении подставляется скин предмета из инвентаря магазина — та же ручная настройка применяется к гостю с тем же market hash и фазой (другой Steam assetId).
          <span className="mt-1 block">
            <strong>База</strong> = фикс. USD или каталог; для режима «Наценка %» база = каталог × (1 + ваш % / 100). Затем к базе применяются скидка гостя и наценка магазина из блока выше.
          </span>
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="radio"
              name="manualMode"
              checked={newManualMode === "fixed"}
              onChange={() => setNewManualMode("fixed")}
            />
            Фиксированная цена (USD)
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input
              type="radio"
              name="manualMode"
              checked={newManualMode === "markup_percent"}
              onChange={() => setNewManualMode("markup_percent")}
            />
            Доп. наценка к каталогу (%)
          </label>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">assetId</span>
            <div className="flex gap-1">
              <input
                placeholder="Steam assetId"
                className={`${input} flex-1 font-mono text-xs`}
                value={newAssetId}
                onChange={(e) => setNewAssetId(e.target.value)}
              />
              <button
                type="button"
                onClick={pasteAssetIdFromClipboard}
                className="shrink-0 rounded-lg border border-zinc-300 px-2 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                title="Вставить из буфера"
              >
                Вставить
              </button>
            </div>
          </div>
          {newManualMode === "fixed" ? (
            <label className="block w-full min-w-[120px] sm:w-36">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Цена USD</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="напр. 1234.56"
                className={input}
                value={newPriceUsd}
                onChange={(e) => setNewPriceUsd(e.target.value)}
              />
            </label>
          ) : (
            <label className="block w-full min-w-[120px] sm:w-36">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Наценка %</span>
              <input
                type="number"
                step="0.1"
                placeholder="напр. 10"
                className={input}
                value={newMarkupPercent}
                onChange={(e) => setNewMarkupPercent(e.target.value)}
              />
            </label>
          )}
          <label className="block min-w-[140px] flex-1">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Заметка (опц.)</span>
            <input
              placeholder="Какой скин / зачем"
              className={input}
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={handleAddManual}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Сохранить
          </button>
        </div>
        {copyHint ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{copyHint}</p> : null}

        {manualPrices.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-xs font-medium text-zinc-500 dark:border-zinc-700">
                  <th className="pb-2 pr-3">Asset ID</th>
                  <th className="pb-2 pr-3">Тип</th>
                  <th className="pb-2 pr-3">Значение</th>
                  <th className="pb-2 pr-3">Заметка</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {manualPrices.map((mp) => (
                  <tr
                    key={mp.id}
                    className="border-b border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="max-w-[200px] py-2 pr-3">
                      <div className="flex items-center gap-1">
                        <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300" title={mp.assetId}>
                          {mp.assetId}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(mp.assetId)}
                          className="shrink-0 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        >
                          Копир.
                        </button>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">
                      {mp.mode === "markup_percent" ? "Наценка %" : "Фикс USD"}
                    </td>
                    <td className="py-2 pr-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {mp.mode === "markup_percent" && mp.markupPercent != null ? (
                        <span>
                          {mp.markupPercent > 0 ? "+" : ""}
                          {mp.markupPercent}%
                        </span>
                      ) : mp.priceUsd != null ? (
                        `$${Number(mp.priceUsd).toFixed(2)}`
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-3 text-zinc-500">{mp.note ?? "—"}</td>
                    <td className="py-2">
                      <button
                        type="button"
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
