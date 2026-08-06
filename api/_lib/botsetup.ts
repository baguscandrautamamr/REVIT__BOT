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
  /**
   * Kalau diisi, bucket berkas export ikut disiapkan.
   *
   * Disuntikkan sebagai fungsi, bukan dipanggil langsung: `scripts/set-commands.ts`
   * berjalan dari terminal dengan env yang belum tentu memuat kredensial
   * Supabase, dan pemasangan menu Telegram tidak boleh gagal hanya karena itu.
   */
  ensureStorage?: () => Promise<void>;
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

    // Baca sebagai teks dulu. Kalau jaringan lewat proxy perusahaan atau
    // Telegram sedang bermasalah, yang kembali adalah HTML — dan `res.json()`
    // langsung melempar "Unexpected token '<'", pesan yang tidak menuntun ke
    // mana pun. Teks mentahnya jauh lebih berguna.
    const raw = await res.text();
    let json: { ok: boolean; description?: string };
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(
        `${method}: balasan bukan JSON (HTTP ${res.status}). ` +
          `Isi awal: ${raw.slice(0, 160)}`,
      );
    }

    if (!json.ok) throw new Error(`${method}: ${json.description ?? `HTTP ${res.status}`}`);
  }

  // 1. Webhook. Dipasang lebih dulu — tanpa ini bot diam total, dan menu
  //    yang rapi tidak ada gunanya.
  if (opts.webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(opts.webhookSecret)) {
    // Dicegat di sini supaya pesannya menyebut penyebabnya. Telegram sendiri
    // hanya menjawab "Bad Request: bad webhook", yang tidak menuntun ke mana pun.
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET mengandung karakter yang ditolak Telegram. ' +
        'Hanya A-Z a-z 0-9 _ - yang diizinkan (1–256 karakter) — karakter + / = ' +
        'khas base64 tidak boleh. Buat ulang dengan: openssl rand -hex 32',
    );
  }

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
  //
  // Kegagalan di sini TIDAK boleh menjatuhkan sisanya. Satu chat ID keliru
  // dulu membatalkan seluruh setup di tengah jalan — webhook sudah terpasang,
  // deskripsi dan tombol panel belum, dan tidak ada yang memberi tahu bahwa
  // hasilnya separuh jadi.
  for (const chatId of opts.adminChatIds) {
    const scope = { type: 'chat', chat_id: chatId };
    try {
      await call('setMyCommands', { commands: menuFor('en', 'admin'), scope });
      for (const locale of LOCALES) {
        await call('setMyCommands', {
          commands: menuFor(locale, 'admin'),
          scope,
          language_code: catalog(locale).meta.bcp47,
        });
      }
      report.steps.push(`menu admin ${chatId} → ${menuFor('en', 'admin').length} command`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.warnings.push(
        /chat not found/i.test(message)
          ? `Chat ID ${chatId} tidak dikenal Telegram. Dua sebab yang mungkin: ` +
            'angkanya salah (mis. masih memakai contoh 123456789), atau akun itu ' +
            'belum pernah mengirim pesan apa pun ke bot. Kirim /status ke bot dari ' +
            'akun tersebut, lalu jalankan ini lagi.'
          : `Menu admin untuk ${chatId} gagal: ${message}`,
      );
    }
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

  // 5. Bucket berkas hasil export.
  //
  // Ditaruh di sini supaya "buka sekali, semuanya terpasang" benar-benar
  // berarti semuanya. Tanpa bucket ini setiap export di atas 3 MB selesai di
  // Revit lalu berkasnya menguap, sementara SELURUH bagian lain bot terlihat
  // sehat sempurna — kegagalan yang paling sulit ditebak dari gejalanya.
  if (opts.ensureStorage) {
    try {
      await opts.ensureStorage();
      report.steps.push('bucket berkas export → siap');
    } catch (err) {
      report.warnings.push(
        `Bucket berkas export gagal dibuat: ${err instanceof Error ? err.message : String(err)}. ` +
          'Export di atas 3 MB tidak akan sampai sampai ini beres — cek /api/health bagian "storage".',
      );
    }
  }

  // 6. Tombol menu Mini App.
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
