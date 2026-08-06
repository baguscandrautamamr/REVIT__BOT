/**
 * Pasang konfigurasi bot ke Telegram dari terminal.
 *
 *   TELEGRAM_BOT_TOKEN=… ADMIN_CHAT_IDS=111,222 npm run set-commands
 *
 * Env opsional:
 *   BASE_URL                 → kalau diisi bersama TELEGRAM_WEBHOOK_SECRET,
 *                              webhook ikut dipasang
 *   TELEGRAM_WEBHOOK_SECRET
 *   PANEL_URL                → tombol Mini App
 *
 * Tidak punya terminal? Buka `/api/admin/setup?secret=<WEBHOOK_SECRET>` di
 * browser — hasilnya sama persis, keduanya memanggil `applyBotSetup()`.
 */
import { applyBotSetup } from '../api/_lib/botsetup';

const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
const baseUrl = (process.env.BASE_URL ?? '').replace(/\/+$/, '');
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

const adminChatIds = (process.env.ADMIN_CHAT_IDS ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n !== 0);

const report = await applyBotSetup({
  botToken,
  baseUrl,
  adminChatIds,
  // Webhook hanya dipasang kalau BASE_URL diketahui — memasangnya ke URL
  // kosong akan mematikan bot yang sedang jalan.
  webhookSecret: baseUrl ? webhookSecret : undefined,
  panelUrl: process.env.PANEL_URL || undefined,
});

for (const step of report.steps) console.log(`✓ ${step}`);
for (const warning of report.warnings) console.warn(`! ${warning}`);
console.log('\nSelesai. Tutup dan buka lagi Telegram supaya menu ter-refresh.');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Env ${name} belum diisi.`);
    process.exit(1);
  }
  return v;
}
