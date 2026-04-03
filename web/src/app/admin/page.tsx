import Link from "next/link";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function AdminHomePage() {
  const [userCount, priceCount, manualCount] = await Promise.all([
    prisma.user.count(),
    prisma.priceCatalogItem.count(),
    prisma.ownerManualPrice.count(),
  ]);

  const cards = [
    { label: "Пользователей", value: userCount },
    { label: "Цен в каталоге", value: priceCount },
    { label: "Ручных цен", value: manualCount },
  ];

  return (
    <main className="mx-auto max-w-2xl space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
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
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href="/admin/pricing"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Настройки цен
          </Link>
          <Link
            href="/api/prices/sync"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            Запустить синк цен
          </Link>
          <Link
            href="/trade"
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            Страница трейда
          </Link>
        </div>
      </div>
    </main>
  );
}
