export type LangCode = "ru" | "en" | "zh";

type Translations = Record<string, Record<LangCode, string>>;

const T: Translations = {
  loading: { ru: "Загрузка...", en: "Loading...", zh: "加载中..." },
  cs2Trade: { ru: "Обмен CS2", en: "CS2 Trade", zh: "CS2 交易" },
  loginSteam: { ru: "Войти через Steam", en: "Sign in via Steam", zh: "通过Steam登录" },
  logout: { ru: "Выйти", en: "Log out", zh: "退出" },
  signedIn: { ru: "Вы вошли через Steam.", en: "You are signed in via Steam.", zh: "您已通过Steam登录。" },

  youGive: { ru: "Вы отдаёте", en: "You give", zh: "您提供" },
  youGet: { ru: "Вы получаете", en: "You get", zh: "您获得" },
  yourInventory: { ru: "Ваш инвентарь", en: "Your inventory", zh: "您的库存" },
  platformInventory: { ru: "Инвентарь платформы", en: "Platform inventory", zh: "平台库存" },
  lockedUntilPrefix: { ru: "Заблокирован до", en: "Locked until", zh: "锁定至" },
  lockedNoDate: { ru: "Заблокировано", en: "Locked", zh: "已锁定" },
  /** One-line hint on locked (admin) cards when `tradeLockUntil` is missing */
  lockedCardLineNoDate: {
    ru: "Этот предмет временно заблокирован",
    en: "This item is temporarily locked",
    zh: "该物品暂时锁定",
  },
  lockedSelectToastWithDate: {
    ru: "Этот предмет заблокирован до {date}. Дождитесь разблокировки, после этого его можно будет добавить в обмен.",
    en: "This item is locked until {date}. Wait until it unlocks, then you can add it to a trade.",
    zh: "该物品将锁定至 {date}。请待解锁后再加入交易。",
  },
  lockedSelectToastNoDate: {
    ru: "Этот предмет временно заблокирован для обмена.",
    en: "This item is temporarily locked for trading.",
    zh: "该物品暂时无法交易。",
  },
  lockedTooltipUnlocksIn: {
    ru: "Разблокируется через {time}",
    en: "Unlocks in {time}",
    zh: "{time} 后解锁",
  },

  loginPrompt: {
    ru: "Войдите через Steam, чтобы начать обменивать ваши CS2 скины на нашей платформе.",
    en: "Sign in via Steam to start trading your CS2 skins on our platform.",
    zh: "通过Steam登录，开始在我们的平台上交易您的CS2皮肤。",
  },

  updateTradeUrl: { ru: "Обновите trade-ссылку", en: "Update trade URL", zh: "更新交易链接" },
  pasteTradeUrl: { ru: "Вставьте вашу trade-ссылку", en: "Paste your trade URL", zh: "粘贴您的交易链接" },
  tradeUrlHint: {
    ru: "Для загрузки вашего инвентаря нужна ваша trade-ссылка Steam.",
    en: "Your Steam trade URL is required to load your inventory.",
    zh: "需要您的Steam交易链接才能加载库存。",
  },
  onlyYourOwn: { ru: "только свою", en: "your own only", zh: "仅限自己的" },
  saveAndLoad: { ru: "Сохранить и загрузить инвентарь", en: "Save & load inventory", zh: "保存并加载库存" },
  cancel: { ru: "Отмена", en: "Cancel", zh: "取消" },
  whereTradeUrl: { ru: "Где найти trade-ссылку? →", en: "Where to find trade URL? →", zh: "在哪里找到交易链接？→" },

  overpay: { ru: "Переплата", en: "Overpay", zh: "超付" },
  sending: { ru: "Отправка...", en: "Sending...", zh: "发送中..." },
  submitTrade: { ru: "Отправить обмен", en: "Submit trade", zh: "提交交易" },

  marketWarning: {
    ru: "некоторые трейды могут быть отклонены из-за нестабильности рынка",
    en: "some trades may be rejected due to market instability",
    zh: "部分交易可能因市场波动而被拒绝",
  },
  priceDisclaimer: {
    ru: "Цены могут отличаться из-за износа, паттерна или наклеек.",
    en: "Prices may vary due to wear, pattern, or stickers.",
    zh: "价格可能因磨损、花纹或贴纸而有所不同。",
  },
  centerPanelFiller: {
    ru: "Подсказка: список магазина объединяет предметы, доступные к обмену из Steam, и отдельный список трейдлока из админки. Заблокированные карточки нельзя выбрать. Фильтры по типу и износу ниже влияют на общий список.",
    en: "Tip: the store list merges Steam-tradable items and a separate trade-lock list from admin. Locked cards cannot be selected. Type and wear filters apply to the full list.",
    zh: "提示：商店列表合并了 Steam 可交易物品与后台单独上传的交易锁定列表。锁定卡片不可选择。类型与磨损筛选作用于整个列表。",
  },

  itemType: { ru: "Тип предмета", en: "Item type", zh: "物品类型" },
  wearLabel: { ru: "Износ", en: "Wear", zh: "磨损" },
  wearAll: { ru: "Все", en: "All", zh: "全部" },

  catAll: { ru: "Все предметы", en: "All items", zh: "所有物品" },
  catWeapon: { ru: "Скины оружия", en: "Weapon skins", zh: "武器皮肤" },
  catKnife: { ru: "Ножи", en: "Knives", zh: "刀具" },
  catGloves: { ru: "Перчатки", en: "Gloves", zh: "手套" },
  catSticker: { ru: "Стикеры", en: "Stickers", zh: "贴纸" },
  catGraffiti: { ru: "Граффити", en: "Graffiti", zh: "涂鸦" },
  catAgent: { ru: "Агенты", en: "Agents", zh: "特工" },
  catMusicKit: { ru: "Муз. наборы", en: "Music Kits", zh: "音乐盒" },
  catPatch: { ru: "Нашивки", en: "Patches", zh: "布章" },
  catCharm: { ru: "Брелоки", en: "Charms", zh: "挂件" },
  catContainer: { ru: "Кейсы", en: "Cases", zh: "箱子" },

  sortPriceDesc: { ru: "Цена: по убыванию", en: "Price: high → low", zh: "价格：从高到低" },
  sortPriceAsc: { ru: "Цена: по возрастанию", en: "Price: low → high", zh: "价格：从低到高" },
  sortNameAsc: { ru: "Имя: A→Z", en: "Name: A→Z", zh: "名称：A→Z" },
  sortNameDesc: { ru: "Имя: Z→A", en: "Name: Z→A", zh: "名称：Z→A" },
  sortFloatAsc: { ru: "Float ↑", en: "Float ↑", zh: "磨损值 ↑" },
  sortFloatDesc: { ru: "Float ↓", en: "Float ↓", zh: "磨损值 ↓" },

  searchPlaceholder: { ru: "Поиск предметов...", en: "Search items...", zh: "搜索物品..." },
  refreshInventory: { ru: "Обновить инвентарь", en: "Refresh inventory", zh: "刷新库存" },
  nextRefreshIn: { ru: "Следующее обновление через", en: "Next refresh in", zh: "下次刷新在" },
  changeTradeUrl: { ru: "Изменить trade-ссылку", en: "Change trade URL", zh: "更改交易链接" },

  noItems: { ru: "Нет предметов", en: "No items", zh: "没有物品" },
  loadingItems: { ru: "Загрузка...", en: "Loading...", zh: "加载中..." },
  allItemsLoaded: { ru: "Все предметы загружены", en: "All items loaded", zh: "所有物品已加载" },

  itemsNotSelected: { ru: "Предметы не выбраны", en: "No items selected", zh: "未选择物品" },
  selectItemsForTrade: { ru: "Выберите предметы для обмена", en: "Select items to trade", zh: "选择要交易的物品" },
  stickers: { ru: "Наклейки", en: "Stickers", zh: "贴纸" },
  stickerN: { ru: "Наклейка", en: "Sticker", zh: "贴纸" },
  inspectInCs2: { ru: "Осмотреть в CS2", en: "Inspect in CS2", zh: "在CS2中检查" },
  copy: { ru: "Копир.", en: "Copy", zh: "复制" },

  addYourItems: { ru: "Добавьте ваши предметы", en: "Add your items", zh: "添加您的物品" },
  selectStoreItems: { ru: "Выберите предметы магазина", en: "Select store items", zh: "选择商店物品" },

  reduceOverpayBy: { ru: "Уменьшите переплату на", en: "Reduce overpay by", zh: "减少超付" },
  maxPercent: { ru: "макс.", en: "max", zh: "最大" },
  addItemsOrRemove: {
    ru: "Добавьте предметы с вашей стороны или уберите с нашей на",
    en: "Add items from your side or remove from ours by",
    zh: "从您这边添加物品或从我们这边移除",
  },
  overpayNotBelow: { ru: "переплата не ниже 0%", en: "overpay must be at least 0%", zh: "超付不低于0%" },
  tradeNoPricing: {
    ru: "Нельзя отправить обмен: нет оценки стоимости выбранных предметов (UNAVAILABLE или нулевая цена).",
    en: "Cannot submit trade: selected items have no valid price (UNAVAILABLE or zero).",
    zh: "无法提交交易：所选物品无有效价格（不可用或为零）。",
  },

  maxItemsPerSide: {
    ru: "Не более {n} предметов с одной стороны",
    en: "No more than {n} items per side",
    zh: "每侧最多{n}件物品",
  },
  tradeCreated: { ru: "Заявка #{id} создана!", en: "Trade #{id} created!", zh: "交易 #{id} 已创建！" },
  errorShop: { ru: "Магазин", en: "Shop", zh: "商店" },
  errorInventory: { ru: "Инвентарь", en: "Inventory", zh: "库存" },
  errorGeneric: { ru: "ошибка", en: "error", zh: "错误" },
  errorRefresh: { ru: "Ошибка обновления", en: "Refresh error", zh: "刷新错误" },
  errorSaveTradeUrl: { ru: "Ошибка сохранения trade-ссылки", en: "Error saving trade URL", zh: "保存交易链接错误" },
  errorGenericShort: { ru: "Ошибка", en: "Error", zh: "错误" },

  footerRights: { ru: "Все права защищены.", en: "All rights reserved.", zh: "保留所有权利。" },
  footerTos: { ru: "Условия использования", en: "Terms of Service", zh: "服务条款" },
  footerPrivacy: { ru: "Политика конфиденциальности", en: "Privacy Policy", zh: "隐私政策" },
  footerCookies: { ru: "Политика cookies", en: "Cookie Policy", zh: "Cookie政策" },

  cookieBannerAria: { ru: "Уведомление о cookie", en: "Cookie notice", zh: "Cookie 提示" },
  cookieBannerText: {
    ru: "Мы используем необходимые cookie (сессия после входа Steam) и локальное хранилище браузера для языка и валюты. Это нужно для работы сайта. Подробнее — на странице политики.",
    en: "We use essential cookies (session after Steam sign-in) and browser local storage for language and currency. This is required for the site to work. See our policy page for details.",
    zh: "我们使用必要的 Cookie（Steam 登录后的会话）和浏览器本地存储来保存语言与货币设置，以便网站正常运行。详情请见政策页面。",
  },
  cookieBannerAccept: { ru: "Принять", en: "Accept", zh: "接受" },
  cookieBannerMore: { ru: "Политика cookies", en: "Cookie policy", zh: "Cookie 政策" },

  footerValve: {
    ru: "Не связано с Valve Corp. Counter‑Strike 2 — торговая марка Valve Corporation.",
    en: "Not affiliated with Valve Corp. Counter‑Strike 2 is a trademark of Valve Corporation.",
    zh: "与Valve Corp无关。Counter‑Strike 2是Valve Corporation的商标。",
  },

  selected: { ru: "Выбрано", en: "Selected", zh: "已选择" },
  of: { ru: "из", en: "of", zh: "共" },
  removeFromSelection: {
    ru: "Нажмите, чтобы убрать из выбора",
    en: "Click to remove from selection",
    zh: "点击从选择中移除",
  },

  daysShort: { ru: "д", en: "d", zh: "天" },
  hoursShort: { ru: "ч", en: "h", zh: "时" },
  minutesShort: { ru: "мин", en: "min", zh: "分" },
  secondsShort: { ru: "с", en: "s", zh: "秒" },
};

export function t(key: string, lang: LangCode): string {
  return T[key]?.[lang] ?? T[key]?.en ?? key;
}

export function requirementsHeading(pending: number, lang: LangCode): string {
  if (pending <= 0) return "";
  if (lang === "en") {
    return `${pending} requirement${pending === 1 ? "" : "s"} remaining`;
  }
  if (lang === "zh") {
    return `还有${pending}项要求`;
  }
  const m10 = pending % 10;
  const m100 = pending % 100;
  if (m10 === 1 && m100 !== 11) return `Осталось ${pending} требование`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `Осталось ${pending} требования`;
  return `Осталось ${pending} требований`;
}

export function formatRefreshCooldown(totalSeconds: number, lang: LangCode): string {
  const sec = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const H = t("hoursShort", lang);
  const M = t("minutesShort", lang);
  const S = t("secondsShort", lang);
  if (h >= 1) return m > 0 ? `${h} ${H} ${m} ${M}` : `${h} ${H}`;
  if (m >= 1) return s > 0 ? `${m} ${M} ${s} ${S}` : `${m} ${M}`;
  return `${s} ${S}`;
}

export function fmtLockI18n(iso: string, lang: LangCode): string {
  const d = new Date(iso).getTime() - Date.now();
  if (d <= 0) return "";
  const days = Math.floor(d / 86_400_000);
  const hrs = Math.floor((d % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}${t("daysShort", lang)}`;
  return `${hrs}${t("hoursShort", lang)}`;
}

/** Absolute date/time for “Locked until …” (manual JSON / owner cards). */
export function formatLockUntilDate(iso: string, lang: LangCode): string {
  const loc = lang === "ru" ? "ru-RU" : lang === "zh" ? "zh-CN" : "en-GB";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/** dd.mm.yyyy, hh:mm for RU toast; locale medium+short otherwise. */
export function formatTradeLockDateDisplay(iso: string, lang: LangCode): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    if (lang === "ru") {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return formatLockUntilDate(iso, lang);
  } catch {
    return iso;
  }
}

/** Toast line when user taps an admin-list item (`locked: true`). */
export function lockedManualItemToastMessage(
  item: { tradeLockUntil: string | null | undefined },
  lang: LangCode,
): string {
  const raw = item.tradeLockUntil?.trim();
  if (raw) {
    const dateStr = formatTradeLockDateDisplay(raw, lang);
    return t("lockedSelectToastWithDate", lang).replace("{date}", dateStr);
  }
  return t("lockedSelectToastNoDate", lang);
}

export type LockedTitleItem = { name: string; tradeLockUntil?: string | null };

/** Subtitle under the name on admin-locked inventory cards. */
export function lockedManualCardSubtitle(item: LockedTitleItem, lang: LangCode): string {
  const raw = item.tradeLockUntil?.trim();
  if (raw) {
    return `${t("lockedUntilPrefix", lang)} ${formatTradeLockDateDisplay(raw, lang)}`;
  }
  return t("lockedCardLineNoDate", lang);
}

/** Native `title` for locked owner cards (hover). */
export function lockedManualItemNativeTitle(item: LockedTitleItem, lang: LangCode): string {
  const base = item.name;
  if (!item.tradeLockUntil?.trim()) {
    return `${base} — ${t("lockedCardLineNoDate", lang)}`;
  }
  const rel = fmtLockI18n(item.tradeLockUntil, lang);
  if (rel) {
    return `${base} — ${t("lockedTooltipUnlocksIn", lang).replace("{time}", rel)}`;
  }
  return `${base} — ${t("lockedUntilPrefix", lang)} ${formatTradeLockDateDisplay(item.tradeLockUntil, lang)}`;
}
