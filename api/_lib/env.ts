/**
 * Pembacaan environment variable, satu tempat.
 *
 * Sengaja tidak melempar error saat modul dimuat: kalau satu env kurang,
 * yang boleh gagal hanyalah endpoint yang membutuhkannya — bukan seluruh
 * deployment. Endpoint /api/health memakai `missingEnv()` untuk melaporkan
 * apa yang kurang tanpa membocorkan nilainya.
 */

export const ENV = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  supabaseUrl: (process.env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  machineToken: process.env.MACHINE_TOKEN ?? '',
  panelUrl: process.env.PANEL_URL ?? '',
};

const REQUIRED = {
  TELEGRAM_BOT_TOKEN: ENV.botToken,
  TELEGRAM_WEBHOOK_SECRET: ENV.webhookSecret,
  SUPABASE_URL: ENV.supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: ENV.supabaseKey,
  MACHINE_TOKEN: ENV.machineToken,
};

/**
 * Telegram hanya menerima A-Z a-z 0-9 _ - untuk `secret_token` (1–256 char).
 *
 * Ini jebakan yang mahal: `openssl rand -base64 32` — cara paling umum orang
 * membuat string acak — menghasilkan `+`, `/`, dan `=`. Akibatnya ganda:
 * `setWebhook` ditolak Telegram, DAN `+` di query string dibaca sebagai spasi
 * oleh browser sehingga endpoint admin menjawab 403 sebelum sempat mencoba.
 * Gejalanya cuma "bot diam", tanpa petunjuk ke arah sini.
 *
 * Yang aman: `openssl rand -hex 32`.
 */
const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

export function webhookSecretValid(): boolean {
  return WEBHOOK_SECRET_RE.test(ENV.webhookSecret);
}

export const WEBHOOK_SECRET_RULE =
  'TELEGRAM_WEBHOOK_SECRET hanya boleh berisi A-Z a-z 0-9 _ - (1–256 karakter). ' +
  'Karakter seperti + / = ditolak Telegram. Buat ulang dengan: openssl rand -hex 32';

/** Nama env yang kosong. Hanya NAMA — nilainya tidak pernah keluar. */
export function missingEnv(): string[] {
  return Object.entries(REQUIRED)
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

export function requireEnv(): void {
  const missing = missingEnv();
  if (missing.length) throw new Error(`Env belum diisi: ${missing.join(', ')}`);
}
