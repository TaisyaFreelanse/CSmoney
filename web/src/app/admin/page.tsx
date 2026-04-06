import Link from "next/link";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function AdminHomePage() {
  const [userCount, priceCount, manualCount, tradePending, tradeTotal] = await Promise.all([
    prisma.user.count(),
    prisma.priceCatalogItem.count(),
    prisma.ownerManualPrice.count(),
    prisma.trade.count({ where: { status: "pending" } }),
    prisma.trade.count(),
  ]);

  const cards = [
    { label: "Заявок (всего)", value: tradeTotal },
    { label: "Ожидают решения", value: tradePending },
    { label: "Пользователей", value: userCount },
    { label: "Цен в каталоге", value: priceCount },
    { label: "Ручных цен", value: manualCount },
  ];

  return (
    <main className="mx-auto max-w-2xl space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
              {c.value}
            </p>
            <p className="text-xs text-zinc-500">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Быстрые действия
        </h2>
        <p className="mt-2 text-xs text-zinc-500">
          Права администратора: вручную <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">isAdmin=true</code> в БД
          или переменная окружения <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">ADMIN_STEAM_IDS</code> (SteamID64
          через запятую) при следующем входе.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin/trades"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Заявки на обмен
          </Link>
          <Link
            href="/admin/users"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            Пользователи
          </Link>
          <Link
            href="/admin/pricing"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            Настройки цен
          </Link>
          <Link
            href="/admin/locked-skins"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            Трейдлок (JSON)
          </Link>
          <Link
            href="/api/prices/sync"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            Запустить синк цен
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            Страница трейда
          </Link>
        </div>
      </div>
    </main>
  );
}
