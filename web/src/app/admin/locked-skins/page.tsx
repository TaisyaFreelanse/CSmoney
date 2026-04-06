"use client";

import { useState } from "react";

export default function AdminLockedSkinsPage() {
  const [jsonText, setJsonText] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function handleSaveFromTextarea() {
    if (!jsonText.trim()) {
      setErr("Вставьте JSON из ответа Steam (например блок с «assets»)");
      return;
    }
    setSaving(true);
    setMsg("");
    setErr("");
    const res = await fetch("/api/admin/owner-trade-lock", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonText }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setMsg(
        typeof data.message === "string"
          ? data.message
          : `Сохранено: ${data.assetIdCount ?? data.count} asset id, ${data.classInstanceKeyCount ?? 0} пар classid+instanceid`,
      );
      setJsonText("");
    } else {
      setErr(data.message ?? data.error ?? "Ошибка сохранения");
    }
    setSaving(false);
  }

  async function handleClearDb() {
    if (!window.confirm("Удалить список из БД? Будет использован файл на сервере (если настроен).")) return;
    setSaving(true);
    setMsg("");
    setErr("");
    const res = await fetch("/api/admin/owner-trade-lock", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setMsg(data.message ?? "Сброшено");
    } else {
      setErr(data.error ?? "Ошибка");
    }
    setSaving(false);
  }

  function onPickFile(f: File | null) {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const t = typeof r.result === "string" ? r.result : "";
      setJsonText(t);
      setMsg(`Файл «${f.name}» загружен в поле — нажмите «Сохранить в БД»`);
    };
    r.readAsText(f, "UTF-8");
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Трейдлок</h1>

      <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">JSON из Steam</label>
        <textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          rows={14}
          placeholder='{ "assets": [ { "assetid": "50881305496", ... }, ... ] }'
          className="w-full rounded-lg border border-zinc-300 bg-white p-3 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700">
            Выбрать файл…
            <input
              type="file"
              accept=".json,application/json,text/plain"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            disabled={saving}
            onClick={handleSaveFromTextarea}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {saving ? "Сохранение…" : "Сохранить в БД"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleClearDb}
            className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            Сбросить БД
          </button>
        </div>
      </div>

      {msg ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{msg}</p> : null}
      {err ? <p className="text-sm text-red-600 dark:text-red-400">{err}</p> : null}
    </main>
  );
}
