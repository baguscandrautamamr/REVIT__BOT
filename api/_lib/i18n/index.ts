import { id } from './id';
import { en } from './en';
import {
  DEFAULT_LOCALE,
  LOCALES,
  type Catalog,
  type LangPref,
  type Locale,
  type Params,
} from './types';

export { DEFAULT_LOCALE, LOCALES };
export type { LangPref, Locale, Params };

const CATALOGS: Record<Locale, Catalog> = { id, en };

/**
 * Urutan penentuan bahasa (yang pertama menang):
 *   1. Preferensi tersimpan di `bot_users.lang` ('id' | 'en')
 *   2. `message.from.language_code` dari Telegram ('id', 'id-ID', 'en-GB', …)
 *   3. DEFAULT_LOCALE
 *
 * `lang = 'auto'` berarti sengaja melompat ke langkah 2 setiap kali,
 * jadi user yang mengubah bahasa HP-nya ikut berubah tanpa /lang lagi.
 */
export function resolveLocale(
  stored: LangPref | null | undefined,
  telegramLanguageCode?: string | null,
): Locale {
  if (stored && stored !== 'auto' && isLocale(stored)) return stored;

  const base = (telegramLanguageCode ?? '').toLowerCase().split('-')[0];
  if (isLocale(base)) return base;

  return DEFAULT_LOCALE;
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Path bertitik ke katalog, mis. `t('id', 'errors.adminOnly')`. */
export type Key = string;

/**
 * Ambil string terjemahan.
 * Key hilang → fallback ke DEFAULT_LOCALE → terakhir kembalikan key-nya sendiri
 * (kelihatan jelek di chat = ketahuan saat testing, bukan diam-diam kosong).
 */
export function t(locale: Locale, key: Key, params: Params = {}): string {
  const node = lookup(CATALOGS[locale], key) ?? lookup(CATALOGS[DEFAULT_LOCALE], key);
  if (node === undefined) return key;
  if (typeof node === 'function') return node(params);
  return interpolate(node, params);
}

/** Helper terikat satu locale — enak dipakai di dalam handler command. */
export function translator(locale: Locale) {
  const fn = (key: Key, params?: Params) => t(locale, key, params);
  fn.locale = locale;
  fn.meta = CATALOGS[locale].meta;
  return fn;
}

export type T = ReturnType<typeof translator>;

export function catalog(locale: Locale): Catalog {
  return CATALOGS[locale];
}

function lookup(obj: unknown, key: Key): string | ((p: Params) => string) | undefined {
  let cur: any = obj;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' || typeof cur === 'function' ? cur : undefined;
}

function interpolate(tpl: string, params: Params): string {
  return tpl.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}
