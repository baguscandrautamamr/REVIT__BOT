/* ============================================================================
   i18n sisi web. Katalog terpisah dari `api/_lib/i18n` karena isinya beda:
   panel butuh label UI, bot butuh kalimat balasan. Yang disamakan hanyalah
   ATURAN-nya: kunci identik, 'auto' berarti ikut bahasa klien.
   ========================================================================== */

const STORAGE_KEY = 'revitbridge.lang';
const SUPPORTED = ['id', 'en'];
const tg = window.Telegram?.WebApp;
const listeners = new Set();

const DICT = {
  id: {
    'app.title': 'Revit Bridge',
    'app.subtitle': 'Panel kontrol · elektrikal',
    'status.online': 'PC online',
    'status.offline': 'PC offline',
    'status.paused': 'Di-pause',
    'status.lastSeen': 'Terakhir terlihat',
    'status.model': 'Model terbuka',
    'status.noModel': 'Belum ada model terbuka',
    'status.revit': 'Revit',
    'status.addin': 'Add-in',
    'queue.title': 'Antrean',
    'queue.empty': 'Tidak ada command yang antre.',
    'queue.pending': 'Menunggu',
    'queue.running': 'Berjalan',
    'queue.done': 'Selesai hari ini',
    'cmd.title': 'Command',
    'cmd.hint': 'Ketuk untuk menyalin ke chat.',
    'cmd.copied': 'Disalin',
    'section.info': 'Info & status',
    'section.query': 'Data model',
    'section.export': 'Export file',
    'section.modify': 'Modifikasi',
    'section.admin': 'Administrasi',
    'pref.title': 'Tampilan',
    'pref.language': 'Bahasa',
    'pref.theme': 'Tema',
    'theme.light': 'Terang',
    'theme.dark': 'Gelap',
    'theme.auto': 'Otomatis',
    'theme.autoNote': 'Otomatis mengikuti tema Telegram / sistem.',
    'role.viewer': 'viewer',
    'role.admin': 'admin',
    'err.load': 'Gagal memuat status. Tarik untuk mencoba lagi.',
    'action.refresh': 'Muat ulang',
  },
  en: {
    'app.title': 'Revit Bridge',
    'app.subtitle': 'Control panel · electrical',
    'status.online': 'PC online',
    'status.offline': 'PC offline',
    'status.paused': 'Paused',
    'status.lastSeen': 'Last seen',
    'status.model': 'Open model',
    'status.noModel': 'No model open yet',
    'status.revit': 'Revit',
    'status.addin': 'Add-in',
    'queue.title': 'Queue',
    'queue.empty': 'No commands queued.',
    'queue.pending': 'Pending',
    'queue.running': 'Running',
    'queue.done': 'Done today',
    'cmd.title': 'Commands',
    'cmd.hint': 'Tap to copy into the chat.',
    'cmd.copied': 'Copied',
    'section.info': 'Info & status',
    'section.query': 'Model data',
    'section.export': 'File export',
    'section.modify': 'Modification',
    'section.admin': 'Administration',
    'pref.title': 'Appearance',
    'pref.language': 'Language',
    'pref.theme': 'Theme',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.auto': 'Auto',
    'theme.autoNote': 'Auto follows your Telegram / system theme.',
    'role.viewer': 'viewer',
    'role.admin': 'admin',
    'err.load': 'Could not load status. Pull to retry.',
    'action.refresh': 'Refresh',
  },
};

let preference = read();

export function getPreference() { return preference; }

export function locale() {
  if (preference !== 'auto') return preference;
  const code = (tg?.initDataUnsafe?.user?.language_code || navigator.language || 'id')
    .toLowerCase()
    .split('-')[0];
  return SUPPORTED.includes(code) ? code : 'id';
}

export function setPreference(next) {
  if (next !== 'auto' && !SUPPORTED.includes(next)) return;
  preference = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* mode privat */ }
  apply();
}

export function t(key, params = {}) {
  const dict = DICT[locale()] ?? DICT.id;
  const raw = dict[key] ?? DICT.id[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
}

/** Terjemahkan ulang seluruh DOM: elemen ber-`data-i18n` diisi teksnya. */
export function apply() {
  document.documentElement.lang = locale();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  }
  for (const fn of listeners) fn(locale(), preference);
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'auto' || SUPPORTED.includes(v)) return v;
  } catch { /* abaikan */ }
  return 'auto';
}
