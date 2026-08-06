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
