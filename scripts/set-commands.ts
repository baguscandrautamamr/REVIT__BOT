/**
 * Daftarkan menu command ke Telegram, per bahasa dan per scope.
 *
 *   npx tsx scripts/set-commands.ts
 *
 * Butuh env: TELEGRAM_BOT_TOKEN, dan opsional ADMIN_CHAT_IDS ("123,456").
 *
 * Kenapa perlu: `setMyCommands` menerima `language_code`. Klien Telegram
 * memilih daftar yang cocok dengan bahasa aplikasi user, jadi user Indonesia
 * melihat deskripsi Indonesia tanpa aksi apa pun. Command tanpa bahasa
 * (default) dipakai sebagai fallback untuk bahasa lain.
 *
 * Scope: command admin TIDAK dimasukkan ke scope default supaya tidak
 * tampil di menu viewer. Command admin dipasang per chat lewat
 * BotCommandScopeChat untuk tiap admin.
 */
import { COMMANDS } from '../api/_lib/commands';
import { LOCALES, catalog, type Locale } from '../api/_lib/i18n';

const TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const API = `https://api.telegram.org/bot${TOKEN}`;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function call(method: string, body: unknown) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  return json;
}

function menuFor(locale: Locale, role: 'viewer' | 'admin') {
  const desc = catalog(locale).commandDesc;
  return COMMANDS.filter((c) => (role === 'admin' ? true : c.inMenu && c.role === 'viewer'))
    .filter((c) => desc[c.name])
    .map((c) => ({ command: c.name, description: desc[c.name] }));
}

async function main() {
  // 1. Menu default (fallback semua bahasa) + tiap bahasa yang didukung.
  await call('setMyCommands', { commands: menuFor('en', 'viewer') });
  console.log(`default   → ${menuFor('en', 'viewer').length} commands`);

  for (const locale of LOCALES) {
    const commands = menuFor(locale, 'viewer');
    await call('setMyCommands', { commands, language_code: catalog(locale).meta.bcp47 });
    console.log(`${locale}        → ${commands.length} commands`);
  }

  // 2. Admin: menu penuh, hanya di chat masing-masing.
  for (const chatId of ADMIN_CHAT_IDS) {
    for (const locale of LOCALES) {
      await call('setMyCommands', {
        commands: menuFor(locale, 'admin'),
        scope: { type: 'chat', chat_id: Number(chatId) },
        language_code: catalog(locale).meta.bcp47,
      });
    }
    await call('setMyCommands', {
      commands: menuFor('en', 'admin'),
      scope: { type: 'chat', chat_id: Number(chatId) },
    });
    console.log(`admin ${chatId} → ${menuFor('en', 'admin').length} commands`);
  }

  // 3. Nama, deskripsi, dan short description — ketiganya per bahasa.
  const texts: Record<Locale, { description: string; short: string }> = {
    id: {
      description:
        '⚡ Bot data model elektrikal Revit. Aktif saat Revit terbuka (jam kerja). Bot internal, bukan layanan 24/7.',
      short: 'Data & export model elektrikal Revit.',
    },
    en: {
      description:
        '⚡ Revit electrical model bot. Live while Revit is open (working hours). Internal tool, not a 24/7 service.',
      short: 'Revit electrical model data & exports.',
    },
  };

  for (const locale of LOCALES) {
    const bcp47 = catalog(locale).meta.bcp47;
    await call('setMyDescription', { description: texts[locale].description, language_code: bcp47 });
    await call('setMyShortDescription', { short_description: texts[locale].short, language_code: bcp47 });
  }
  await call('setMyDescription', { description: texts.en.description });
  await call('setMyShortDescription', { short_description: texts.en.short });

  console.log('\n✅ Menu, deskripsi, dan short description terpasang untuk id + en.');
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
