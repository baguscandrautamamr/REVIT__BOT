/**
 * Handler /lang dan /theme — dua command yang mengubah preferensi user.
 *
 * Keduanya menerima dua bentuk:
 *   - dengan argumen: `/lang en`, `/theme dark`  → langsung disimpan
 *   - tanpa argumen:  `/lang`                    → tampilkan inline keyboard
 *
 * Callback keyboard memakai prefix `pref:` supaya router callback di webhook
 * bisa memilahnya dari konfirmasi dua langkah (`confirm:`).
 */
import { answerCallbackQuery, editMessageText, mdv2, sendMessage } from './telegram';
import { LOCALES, catalog, isLocale, resolveLocale, translator, type LangPref, type Locale } from './i18n';

export type ThemePref = 'auto' | 'light' | 'dark';

export interface UserRow {
  chat_id: number;
  lang: LangPref;
  theme: ThemePref;
}

/** Diimplementasi di `_lib/supabase.ts`; dipisah supaya mudah di-test. */
export interface Store {
  setLang(chatId: number, lang: LangPref): Promise<void>;
  setTheme(chatId: number, theme: ThemePref): Promise<void>;
}

const THEME_VALUES: ThemePref[] = ['auto', 'light', 'dark'];

/* ── /lang ─────────────────────────────────────────────────────────────── */

export async function handleLang(
  user: UserRow,
  args: string[],
  telegramLangCode: string | null,
  store: Store,
) {
  const current = resolveLocale(user.lang, telegramLangCode);
  const t = translator(current);
  const arg = args[0]?.toLowerCase();

  if (!arg) {
    return sendMessage(user.chat_id, mdv2(t('lang.prompt')), {
      reply_markup: { inline_keyboard: [langButtons(user.lang)] },
    });
  }

  const next: LangPref | null = arg === 'auto' ? 'auto' : isLocale(arg) ? arg : null;
  if (!next) {
    return sendMessage(user.chat_id, mdv2(t('errors.badArgs', { example: '/lang id · /lang en · /lang auto' })));
  }

  await store.setLang(user.chat_id, next);

  // Balas dalam bahasa BARU — konfirmasi perubahan bahasa yang masih memakai
  // bahasa lama terasa seperti gagal.
  const after = resolveLocale(next, telegramLangCode);
  const t2 = translator(after);
  const label = next === 'auto' ? t2('lang.auto') : catalog(after).meta.nativeName;
  const key = after === current && next !== 'auto' ? 'lang.unchanged' : 'lang.changed';
  return sendMessage(user.chat_id, mdv2(t2(key, { lang: label })));
}

function langButtons(current: LangPref) {
  const row = LOCALES.map((l) => ({
    text: `${catalog(l).meta.flag} ${catalog(l).meta.nativeName}${current === l ? ' ✓' : ''}`,
    callback_data: `pref:lang:${l}`,
  }));
  row.push({ text: `🌐 Auto${current === 'auto' ? ' ✓' : ''}`, callback_data: 'pref:lang:auto' });
  return row;
}

/* ── /theme ────────────────────────────────────────────────────────────── */

export async function handleTheme(
  user: UserRow,
  args: string[],
  telegramLangCode: string | null,
  store: Store,
) {
  const locale = resolveLocale(user.lang, telegramLangCode);
  const t = translator(locale);
  const arg = args[0]?.toLowerCase() as ThemePref | undefined;

  if (!arg) {
    return sendMessage(user.chat_id, mdv2(t('lang.themePrompt')), {
      reply_markup: { inline_keyboard: [themeButtons(user.theme, locale)] },
    });
  }

  if (!THEME_VALUES.includes(arg)) {
    return sendMessage(user.chat_id, mdv2(t('errors.badArgs', { example: '/theme light · /theme dark · /theme auto' })));
  }

  await store.setTheme(user.chat_id, arg);
  return sendMessage(user.chat_id, mdv2(themeLabel(arg, locale) + ' ✓'));
}

function themeButtons(current: ThemePref, locale: Locale) {
  return THEME_VALUES.map((v) => ({
    text: themeLabel(v, locale) + (current === v ? ' ✓' : ''),
    callback_data: `pref:theme:${v}`,
  }));
}

function themeLabel(v: ThemePref, locale: Locale): string {
  const id = { auto: '🌓 Otomatis', light: '☀️ Terang', dark: '🌙 Gelap' };
  const en = { auto: '🌓 Auto', light: '☀️ Light', dark: '🌙 Dark' };
  return (locale === 'id' ? id : en)[v];
}

/* ── Callback dari inline keyboard ─────────────────────────────────────── */

/** `data` berbentuk `pref:lang:en` atau `pref:theme:dark`. */
export async function handlePrefCallback(
  query: { id: string; data: string; message?: { chat: { id: number }; message_id: number } },
  user: UserRow,
  telegramLangCode: string | null,
  store: Store,
) {
  const [, kind, value] = query.data.split(':');

  if (kind === 'lang') {
    const next = (value === 'auto' ? 'auto' : isLocale(value) ? value : null) as LangPref | null;
    if (!next) return answerCallbackQuery(query.id);
    await store.setLang(user.chat_id, next);

    const after = resolveLocale(next, telegramLangCode);
    const t = translator(after);
    const label = next === 'auto' ? t('lang.auto') : catalog(after).meta.nativeName;
    await answerCallbackQuery(query.id, t('lang.changed', { lang: label }));
    if (query.message) {
      await editMessageText(query.message.chat.id, query.message.message_id, mdv2(t('lang.changed', { lang: label })));
    }
    return;
  }

  if (kind === 'theme' && THEME_VALUES.includes(value as ThemePref)) {
    await store.setTheme(user.chat_id, value as ThemePref);
    const locale = resolveLocale(user.lang, telegramLangCode);
    await answerCallbackQuery(query.id, themeLabel(value as ThemePref, locale));
    if (query.message) {
      await editMessageText(query.message.chat.id, query.message.message_id, mdv2(themeLabel(value as ThemePref, locale) + ' ✓'));
    }
    return;
  }

  return answerCallbackQuery(query.id);
}
