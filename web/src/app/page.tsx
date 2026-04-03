import Link from "next/link";

import { getSessionUser } from "@/lib/auth";

const ERROR_MESSAGES: Record<string, string> = {
  steam_invalid_mode: "Вход через Steam прерван. Попробуйте снова.",
  steam_not_valid: "Steam не подтвердил вход. Попробуйте снова.",
  steam_no_claimed_id: "Некорректный ответ Steam. Попробуйте позже.",
  steam_bad_claimed_id: "Некорректный идентификатор Steam.",
  banned: "Аккаунт заблокирован.",
  session_config: "На сервере не настроена сессия (SESSION_SECRET). Обратитесь к администратору.",
};

type Props = {
  searchParams: Promise<{ error?: string; signed_in?: string }>;
};

export default async function Home({ searchParams }: Props) {
  const sp = await searchParams;
  const user = await getSessionUser();
  const errorKey = sp.error;
  const errorText = errorKey ? ERROR_MESSAGES[errorKey] ?? `Ошибка: ${errorKey}` : null;

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-zinc-950">
      <main className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          CS2 trade — MVP
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Обмен скинами CS2. Войдите через Steam, вставьте trade-ссылку и выберите предметы.
        </p>

        {errorText ? (
          <p
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            role="alert"
          >
            {errorText}
          </p>
        ) : null}

        {sp.signed_in === "1" && user ? (
          <p className="mt-4 text-sm text-emerald-700 dark:text-emerald-400">Вы вошли через Steam.</p>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {user ? (
            <>
              <div className="flex items-center gap-3">
                {user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt=""
                    className="h-10 w-10 rounded-full"
                    width={40}
                    height={40}
                  />
                ) : null}
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {user.displayName ?? user.steamId}
                  </p>
                  <p className="text-xs text-zinc-500">Steam ID: {user.steamId}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/trade"
                  className="inline-flex items-center justify-center rounded-lg bg-[#171a21] px-4 py-2 text-sm font-medium text-white hover:bg-[#2a475e]"
                >
                  Трейд
                </Link>
                {user.isAdmin ? (
                  <Link
                    href="/admin"
                    className="inline-flex items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                  >
                    Админка
                  </Link>
                ) : null}
                <form action="/api/auth/logout" method="POST">
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                  >
                    Выйти
                  </button>
                </form>
              </div>
            </>
          ) : (
            <a
              href="/api/auth/steam"
              className="inline-flex w-full items-center justify-center rounded-lg bg-[#171a21] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#2a475e] sm:w-auto"
            >
              Войти через Steam
            </a>
          )}
        </div>

        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-500">
          Проверка API:{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
            GET /api/health
          </code>{" "}
          (при рабочей{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">DATABASE_URL</code>{" "}
          вернётся{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
            database: &quot;up&quot;
          </code>
          ).
        </p>
      </main>
    </div>
  );
}
