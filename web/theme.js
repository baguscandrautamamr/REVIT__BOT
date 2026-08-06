/* ============================================================================
   Pengendali tema — dipakai panel web dan Telegram Mini App.
   ----------------------------------------------------------------------------
   Tiga nilai preferensi: 'light' | 'dark' | 'auto'.
   'auto' berarti ikut sumber terbaik yang tersedia, berurutan:
     1. Telegram.WebApp.colorScheme  (kalau dibuka sebagai Mini App)
     2. prefers-color-scheme         (browser biasa)

   Preferensi disimpan di localStorage, dan — kalau dibuka dari Telegram —
   ikut disinkronkan ke server supaya `/theme` di chat dan toggle di panel
   menunjuk ke nilai yang sama.
   ========================================================================== */

const STORAGE_KEY = 'revitbridge.theme';
const VALID = new Set(['light', 'dark', 'auto']);

const tg = window.Telegram?.WebApp;
const mql = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

let preference = read();

/** Tema yang benar-benar dipakai sekarang ('light' | 'dark'). */
export function effectiveTheme() {
  if (preference !== 'auto') return preference;
  if (tg?.colorScheme === 'light' || tg?.colorScheme === 'dark') return tg.colorScheme;
  return mql.matches ? 'dark' : 'light';
}

export function getPreference() {
  return preference;
}

export function setPreference(next, { persist = true } = {}) {
  if (!VALID.has(next)) return;
  preference = next;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* mode privat */ }
  }
  apply();
}

/**
 * Terapkan ke DOM.
 * `data-theme` hanya dipasang saat user memilih eksplisit — saat 'auto'
 * atributnya DIHAPUS supaya media query di theme.css yang mengambil alih.
 * Ini penting: kalau 'auto' ditulis sebagai data-theme="light", perangkat
 * gelap akan terkunci terang.
 */
function apply() {
  const root = document.documentElement;
  if (preference === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);

  const eff = effectiveTheme();
  root.style.colorScheme = eff;

  // Warna bar browser mobile disamakan dengan latar, supaya tidak ada
  // pita putih di atas saat tema gelap.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', eff === 'dark' ? '#0a0b10' : '#f2f3f7');

  // Telegram Mini App: samakan header & background chrome-nya.
  if (tg?.setHeaderColor) {
    try {
      tg.setHeaderColor(eff === 'dark' ? '#0a0b10' : '#f2f3f7');
      tg.setBackgroundColor?.(eff === 'dark' ? '#0a0b10' : '#f2f3f7');
    } catch { /* versi Telegram lama tidak mendukung warna kustom */ }
  }

  for (const fn of listeners) fn(eff, preference);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (VALID.has(v)) return v;
  } catch { /* abaikan */ }
  return 'auto';
}

// Perubahan tema OS / Telegram hanya berpengaruh saat preferensi 'auto'.
mql.addEventListener?.('change', () => { if (preference === 'auto') apply(); });
tg?.onEvent?.('themeChanged', () => { if (preference === 'auto') apply(); });

apply();
