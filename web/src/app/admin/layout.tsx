import Link from "next/link";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  if (!user?.isAdmin) {
    redirect("/");
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Админка</p>
          <p className="text-xs text-zinc-500">
            {user.displayName ?? user.steamId}
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <Link href="/admin" className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            Обзор
          </Link>
          <Link
            href="/admin/trades"
            className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Заявки
          </Link>
          <Link
            href="/admin/users"
            className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Пользователи
          </Link>
          <Link href="/admin/pricing" className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            Цены
          </Link>
          <Link
            href="/admin/locked-skins"
            className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Трейдлок
          </Link>
          <Link href="/" className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            На сайт
          </Link>
        </nav>
      </header>
      <div className="px-6 py-8">{children}</div>
    </div>
  );
}
