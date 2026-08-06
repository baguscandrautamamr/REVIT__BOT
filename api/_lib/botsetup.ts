/**
 * Pemasangan konfigurasi bot ke Telegram: webhook, menu command dua bahasa,
 * deskripsi profil, dan tombol Mini App.
 *
 * Dipakai dua jalur:
 *   - `scripts/set-commands.ts`  (dari terminal)
 *   - `api/admin/setup.ts`       (dari browser, tanpa terminal)
 *
 * Keduanya memanggil fungsi yang sama supaya hasilnya tidak pernah berbeda
 * tergantung siapa yang menjalankan.
 */
import { COMMANDS } from './commands';
import { LOCALES, catalog, type Locale } from './i18n';

export interface SetupOptions {
  botToken: string;
  /** Asal server, mis. `https://revit-bot.vercel.app` (tanpa slash akhir). */
  baseUrl: string;
  /** Chat ID admin — mereka mendapat menu penuh lewat BotCommandScopeChat. */
  adminChatIds: number[];
  /** Kalau diisi, webhook ikut dipasang. */
  webhookSecret?: string;
  /** Kalau diisi, tombol menu Mini App ikut dipasang. */
  panelUrl?: string;
}

export interface SetupReport {
  steps: string[];
  warnings: string[];
}

const DESCRIPTIONS: Record<Locale, { description: string; short: string }> = {
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

export function menuFor(locale: Locale, role: 'viewer' | 'admin') {
  const desc = catalog(locale).commandDesc;
  return COMMANDS.filter((c) => (role === 'admin' ? true : c.inMenu && c.role === 'viewer'))
    .filter((c) => desc[c.name])
    .map((c) => ({ command: c.name, description: desc[c.name] }));
}

export async function applyBotSetup(opts: SetupOptions): Promise<SetupReport> {
  const report: SetupReport = { steps: [], warnings: [] };
  const api = `https://api.telegram.org/bot${opts.botToken}`;

  async function call(method: string, body: unknown): Promise<void> {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
  }

  // 1. Webhook. Dipasang lebih dulu — tanpa ini bot diam total, dan menu
  //    yang rapi tidak ada gunanya.
  if (opts.webhookSecret) {
    await call('setWebhook', {
      url: `${opts.baseUrl}/api/telegram/webhook`,
      secret_token: opts.webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      max_connections: 20,
    });
    report.steps.push(`webhook → ${opts.baseUrl}/api/telegram/webhook`);
  } else {
    report.warnings.push('TELEGRAM_WEBHOOK_SECRET kosong — webhook tidak dipasang');
  }

  // 2. Menu default (fallback untuk bahasa selain id/en) + tiap bahasa.
  await call('setMyCommands', { commands: menuFor('en', 'viewer') });
  report.steps.push(`menu default → ${menuFor('en', 'viewer').length} command`);

  for (const locale of LOCALES) {
    const commands = menuFor(locale, 'viewer');
    await call('setMyCommands', { commands, language_code: catalog(locale).meta.bcp47 });
    report.steps.push(`menu ${locale} → ${commands.length} command`);
  }

  // 3. Menu penuh untuk admin, per chat.
  for (const chatId of opts.adminChatIds) {
    const scope = { type: 'chat', chat_id: chatId };
    await call('setMyCommands', { commands: menuFor('en', 'admin'), scope });
    for (const locale of LOCALES) {
      await call('setMyCommands', {
        commands: menuFor(locale, 'admin'),
        scope,
        language_code: catalog(locale).meta.bcp47,
      });
    }
    report.steps.push(`menu admin ${chatId} → ${menuFor('en', 'admin').length} command`);
  }
  if (opts.adminChatIds.length === 0) {
    report.warnings.push(
      'Belum ada admin di tabel bot_users — menu admin belum dipasang. ' +
        'Tambahkan barismu dengan role admin, lalu buka URL ini lagi.',
    );
  }

  // 4. Deskripsi profil, per bahasa.
  for (const locale of LOCALES) {
    const bcp47 = catalog(locale).meta.bcp47;
    await call('setMyDescription', { description: DESCRIPTIONS[locale].description, language_code: bcp47 });
    await call('setMyShortDescription', { short_description: DESCRIPTIONS[locale].short, language_code: bcp47 });
  }
  await call('setMyDescription', { description: DESCRIPTIONS.en.description });
  await call('setMyShortDescription', { short_description: DESCRIPTIONS.en.short });
  report.steps.push('deskripsi profil → id + en + default');

  // 5. Tombol menu Mini App.
  if (opts.panelUrl) {
    await call('setChatMenuButton', {
      menu_button: { type: 'web_app', text: 'Panel', web_app: { url: opts.panelUrl } },
    });
    report.steps.push(`tombol panel → ${opts.panelUrl}`);
  } else {
    report.warnings.push('PANEL_URL kosong — tombol Mini App tidak dipasang');
  }

  return report;
}
