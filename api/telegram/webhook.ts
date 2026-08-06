/**
 * POST /api/telegram/webhook — satu-satunya pintu masuk dari Telegram.
 *
 * Aturan yang mengikat handler ini:
 *   1. Verifikasi header rahasia sebelum apa pun.
 *   2. SELALU balas 200, bahkan saat gagal. Non-2xx = Telegram mengirim ulang
 *      update yang sama, dan `/pdf` bisa jalan dua kali.
 *   3. Tidak ada kerja berat di sini. Command yang butuh Revit hanya
 *      dimasukkan ke antrean, lalu dibalas "⏳".
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import { parseCommand, type CommandSpec } from '../_lib/commands';
import * as db from '../_lib/db';
import { ENV } from '../_lib/env';
import { resolveLocale, translator, type Locale } from '../_lib/i18n';
import { HEAVY, LIMITS, cooldownRemaining, isOnline } from '../_lib/limits';
import { helpText, queueText, statusText, usersText } from '../_lib/reply';
import {
  answerCallbackQuery,
  chunk,
  mdv2,
  sendMessage,
  verifyWebhookSecret,
} from '../_lib/telegram';
import { handleLang, handlePrefCallback, handleTheme } from './preferences';

/** Command yang dijawab server sendiri, tanpa menyentuh Revit. */
const SERVER_SIDE = new Set([
  'help', 'status', 'queue', 'lang', 'theme', 'panelapp',
  'users', 'pause', 'resume', 'cancel',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  if (!verifyWebhookSecret(headerOf(req, 'x-telegram-bot-api-secret-token'))) {
    // 403 di sini aman: yang datang bukan Telegram, jadi tidak ada yang
    // perlu di-retry.
    return res.status(403).send('forbidden');
  }

  try {
    await route(req.body ?? {});
  } catch (err) {
    // Status tetap 200 (aturan 2), tapi jangan diam ke user: bot yang diam
    // total tidak bisa dibedakan dari webhook yang tidak terpasang, dan
    // orang akan menghabiskan waktu mencari di tempat yang salah.
    console.error('[webhook]', err);
    await notifyFailure(req.body, err);
  }
  return res.status(200).json({ ok: true });
}

async function route(update: any): Promise<void> {
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.message?.text) return onMessage(update.message, update.update_id);
}

/* ── Pesan teks ────────────────────────────────────────────────────────── */

async function onMessage(msg: any, updateId: number): Promise<void> {
  const chatId: number = msg.chat.id;
  const tgLang: string | null = msg.from?.language_code ?? null;
  const text: string = msg.text.trim();

  if (!text.startsWith('/')) return; // bot ini hanya menerima command

  // Dedupe: retry Telegram membawa update_id yang sama.
  if (!(await claimUpdate(updateId))) return;

  const user = await db.getUser(chatId);
  const locale = resolveLocale(user?.lang, tgLang);
  const t = translator(locale);

  if (!user) {
    // Balasan ini sengaja menyertakan chat ID: itu satu-satunya cara user
    // tahu angka apa yang harus diberikan ke admin.
    await sendMessage(chatId, mdv2(t('errors.notRegistered', { chatId })));
    return;
  }
  if (!user.is_active) {
    await sendMessage(chatId, mdv2(t('errors.inactive')));
    return;
  }

  const machine = await db.getMachine();
  const { spec, raw, args } = parseCommand(text);

  if (!machine.bot_enabled && spec?.name !== 'status') {
    await sendMessage(chatId, mdv2(t('errors.botDisabled')));
    return;
  }
  if (!spec) {
    await sendMessage(chatId, mdv2(t('errors.unknownCommand', { cmd: '/' + raw })));
    return;
  }
  if (spec.role === 'admin' && user.role !== 'admin') {
    await sendMessage(chatId, mdv2(t('errors.adminOnly')));
    return;
  }
  if (LIMITS[user.role].blocked.includes(spec.name)) {
    await sendMessage(chatId, mdv2(t('errors.adminOnly')));
    return;
  }

  if (SERVER_SIDE.has(spec.name)) {
    await serverSide(spec, user, machine, args, tgLang, locale);
    return;
  }
  await enqueue(spec, user, machine, args, locale);
}

/* ── Command yang dijawab langsung ─────────────────────────────────────── */

async function serverSide(
  spec: CommandSpec,
  user: db.BotUser,
  machine: db.MachineState,
  args: string[],
  tgLang: string | null,
  locale: Locale,
): Promise<void> {
  const t = translator(locale);
  const chatId = user.chat_id;

  switch (spec.name) {
    case 'help':
      for (const part of chunk(helpText(locale, user.role))) {
        await sendMessage(chatId, part);
      }
      return;

    case 'status': {
      const queue = await db.queueSnapshot();
      await sendMessage(chatId, statusText(locale, machine, queue));
      return;
    }

    case 'queue': {
      const queue = await db.queueSnapshot();
      await sendMessage(chatId, queueText(locale, chatId, queue));
      return;
    }

    case 'lang':
      await handleLang(user, args, tgLang, store);
      return;

    case 'theme':
      await handleTheme(user, args, tgLang, store);
      return;

    case 'panelapp': {
      if (!ENV.panelUrl) {
        await sendMessage(chatId, mdv2(t('errors.internal')));
        return;
      }
      await sendMessage(chatId, mdv2(t('help.title')), {
        reply_markup: {
          inline_keyboard: [[{ text: '📊 Panel', web_app: { url: ENV.panelUrl } }]],
        },
      });
      return;
    }

    case 'users':
      await sendMessage(chatId, usersText(locale, await db.listUsers()));
      return;

    case 'pause':
      await db.updateMachine({ is_paused: true });
      await sendMessage(chatId, mdv2(t('admin.paused')));
      return;

    case 'resume':
      await db.updateMachine({ is_paused: false });
      await sendMessage(chatId, mdv2(t('admin.resumed')));
      return;

    case 'cancel': {
      const prefix = args[0];
      if (!prefix) {
        await sendMessage(chatId, mdv2(t('errors.missingArgs', { example: '/cancel 3f9a' })));
        return;
      }
      const job = await db.findPendingByPrefix(prefix);
      if (!job) {
        await sendMessage(chatId, mdv2(t('admin.notCancellable')));
        return;
      }
      await db.cancelCommand(job.id);
      await sendMessage(chatId, mdv2(t('admin.cancelled', { id: job.id.slice(0, 8) })));
      return;
    }
  }
}

/* ── Command yang diantre ke Revit ─────────────────────────────────────── */

async function enqueue(
  spec: CommandSpec,
  user: db.BotUser,
  machine: db.MachineState,
  args: string[],
  locale: Locale,
): Promise<void> {
  const t = translator(locale);
  const chatId = user.chat_id;

  const built = buildPayload(spec, args, locale);
  if ('error' in built) {
    await sendMessage(chatId, mdv2(built.error));
    return;
  }

  // Batas jumlah sheet per role.
  const views = (built.payload.views as string[] | undefined) ?? [];
  const max = LIMITS[user.role].maxSheets;
  if (views.length > max) {
    await sendMessage(chatId, mdv2(t('errors.tooManySheets', { max, asked: views.length })));
    return;
  }

  // Cooldown untuk command berat.
  if (HEAVY.includes(spec.name)) {
    const remaining = cooldownRemaining(await db.lastHeavyCommandAt(chatId, HEAVY));
    if (remaining > 0) {
      await sendMessage(chatId, mdv2(t('errors.cooldown', { seconds: remaining })));
      return;
    }
  }

  const job = await db.insertCommand({
    chat_id: chatId,
    command: spec.name,
    payload: built.payload,
    lang: locale,
  });

  // Pesan "⏳" disimpan message_id-nya supaya nanti di-EDIT, bukan ditimpa
  // pesan baru — riwayat chat tetap satu baris per perintah.
  const head = isOnline(machine.last_seen_at)
    ? t('common.queued')
    : t('errors.pcOffline', {
        since: machine.last_seen_at
          ? new Date(machine.last_seen_at).toLocaleString(locale === 'id' ? 'id-ID' : 'en-GB')
          : '—',
        ago: '—',
      });

  const sent = await sendMessage(chatId, mdv2(`${head}\n#${job.id.slice(0, 8)} /${spec.name}`));
  await db.setCommandMessageId(job.id, sent.message_id);
}

type Built = { payload: Record<string, unknown> } | { error: string };

function buildPayload(spec: CommandSpec, args: string[], locale: Locale): Built {
  const t = translator(locale);
  const example = spec.usage?.[locale] ?? `/${spec.name}`;
  const positional = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--')).map((f) => f.slice(2));

  switch (spec.name) {
    case 'levels':
    case 'warnings':
    case 'nwc':
    case 'ifc':
      return { payload: {} };

    case 'sheets':
      return { payload: { filter: positional[0] ?? null } };

    case 'count': {
      if (!positional[0]) return { error: t('errors.missingArgs', { example }) };
      return {
        payload: {
          level: positional[0],
          category: positional[1] ?? null,
          detail: flags.includes('detail'),
        },
      };
    }

    case 'tray':
      if (!positional[0]) return { error: t('errors.missingArgs', { example }) };
      return { payload: { level: positional[0], groupBy: 'comments' } };

    case 'load':
      if (!positional[0]) return { error: t('errors.missingArgs', { example }) };
      return { payload: { level: positional[0] } };

    case 'panel':
      if (!positional[0]) return { error: t('errors.missingArgs', { example }) };
      return { payload: { panel: positional[0] } };

    case 'find':
      if (!positional[0]) return { error: t('errors.missingArgs', { example }) };
      return { payload: { mark: positional[0] } };

    case 'pdf':
    case 'png':
    case 'dwg':
      if (!positional.length) return { error: t('errors.missingArgs', { example }) };
      return { payload: { views: positional } };

    case 'schedule':
      if (!positional[0]) return { error: t('errors.missingArgs', { example }) };
      return { payload: { schedule: positional[0], format: 'csv' } };

    case 'setparam':
    case 'tag':
    case 'dynamo':
      // Modifikasi selalu masuk sebagai dryRun; eksekusi nyata baru terjadi
      // setelah konfirmasi (lihat docs §11).
      if (!positional.length) return { error: t('errors.missingArgs', { example }) };
      return { payload: { args: positional, flags, dryRun: true } };

    default:
      return { payload: { args: positional, flags } };
  }
}

/* ── Callback dari inline keyboard ─────────────────────────────────────── */

async function onCallback(query: any): Promise<void> {
  const chatId: number = query.from.id;
  const data: string = query.data ?? '';

  const user = await db.getUser(chatId);
  if (!user || !user.is_active) {
    await answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith('pref:')) {
    await handlePrefCallback(
      { id: query.id, data, message: query.message },
      user,
      query.from.language_code ?? null,
      store,
    );
    return;
  }

  // Konfirmasi dua langkah belum terpasang sampai /setparam diaktifkan;
  // tetap dijawab supaya tombolnya tidak berputar di klien.
  await answerCallbackQuery(query.id);
}

/* ── Utilitas ──────────────────────────────────────────────────────────── */

const store = {
  setLang: (chatId: number, lang: db.LangPref) => db.updateUser(chatId, { lang }),
  setTheme: (chatId: number, theme: db.ThemePref) => db.updateUser(chatId, { theme }),
};

/**
 * Usaha terakhir memberi tahu user saat handler gagal total.
 * Sengaja memakai teks polos tanpa MarkdownV2: kalau penyebab gagalnya justru
 * escaping, pesan errornya sendiri tidak boleh ikut gagal terkirim.
 */
async function notifyFailure(body: any, err: unknown): Promise<void> {
  const chatId = body?.message?.chat?.id ?? body?.callback_query?.from?.id;
  if (typeof chatId !== 'number') return;

  const detail = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
  try {
    await sendMessage(chatId, `⚠️ Terjadi kesalahan di server.\n\n${detail}`, {
      parse_mode: undefined,
    });
  } catch (sendErr) {
    console.error('[webhook] gagal mengabari user', sendErr);
  }
}

function headerOf(req: VercelRequest, name: string): string | null {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Klaim `update_id`. Mengembalikan false kalau update ini sudah pernah
 * diproses — insert akan gagal karena primary key bentrok.
 */
async function claimUpdate(updateId: number): Promise<boolean> {
  if (typeof updateId !== 'number') return true;
  try {
    await fetch(`${ENV.supabaseUrl}/rest/v1/tg_updates`, {
      method: 'POST',
      headers: {
        apikey: ENV.supabaseKey,
        authorization: `Bearer ${ENV.supabaseKey}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify([{ update_id: updateId }]),
    }).then((r) => {
      if (r.status === 409) throw new Error('duplicate');
      if (!r.ok) throw new Error(`tg_updates ${r.status}`);
    });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === 'duplicate') return false;
    // Tabel belum ada / Supabase sedang bermasalah: lebih baik memproses
    // daripada diam total. Duplikat jauh lebih jarang daripada downtime.
    console.error('[dedupe]', err);
    return true;
  }
}

export const config = { api: { bodyParser: true } };
