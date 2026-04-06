"use client";

import { useCallback, useState } from "react";

type Props = {
  url: string | null;
  /** Wider layout for the trade detail “Пользователь” block */
  variant?: "table" | "detail";
};

export function AdminTradeUrlField({ url, variant = "table" }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [url]);

  if (!url) {
    return <span className="text-zinc-500 dark:text-zinc-500">Не указан</span>;
  }

  const wrap =
    variant === "detail"
      ? "mt-1 flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2"
      : "flex min-w-0 items-center gap-1.5";

  return (
    <div className={wrap}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={
          variant === "detail"
            ? "min-w-0 truncate text-sm text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
            : "min-w-0 flex-1 truncate text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
        }
        title={url}
      >
        {url}
      </a>
      <button
        type="button"
        onClick={() => void copy()}
        className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        {copied ? "Скопировано" : "Скопировать"}
      </button>
    </div>
  );
}
