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

import {
  SERVER_SIDE,
  notImplemented,
  parseCommand,
  splitArgs,
  type CommandSpec,
} from '../_lib/commands';
import * as db from '../_lib/db';
import { ENV } from '../_lib/env';
import { resolveLocale, translator, type Locale } from '../_lib/i18n';
import { HEAVY, LIMITS, cooldownRemaining, isOnline } from '../_lib/limits';
import {
  absoluteTime,
  helpText,
  queueText,
  relativeTime,
  statusText,
  usersText,
} from '../_lib/reply';
import { PROJECT_PREFIX, handleProject, handleProjectCallback, targetProject } from '../_lib/projects';
import { closeInChat, sweepQuietly } from '../_lib/sweep';
import {
  answerCallbackQuery,
  chunk,
  mdv2,
  sendMessage,
  verifyWebhookSecret,
} from '../_lib/telegram';
import { handleLang, handlePrefCallback, handleTheme } from '../_lib/preferences';

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

  // Sapu job mati di sini juga, bukan hanya di /claim. Kalau PC-nya justru
  // yang mati, /claim tidak pernah dipanggil — dan tanpa ini pesan "⏳" milik
  // orang lain menggantung sampai ada yang membuka Revit lagi.
  const [user] = await Promise.all([db.getUser(chatId), sweepQuietly()]);
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

  // Ditolak DI SINI, bukan setelah keliling ke Revit. Add-in memang menjawab
  // "belum diimplementasi", tapi jawaban itu baru sampai setelah job melewati
  // Supabase, polling, dan main thread Revit — dan kalau PC-nya kebetulan mati,
  // baru setelah menggantung 10 menit lalu kedaluwarsa. Padahal jawabannya
  // sudah pasti sejak awal.
  if (notImplemented(spec)) {
    await sendMessage(chatId, mdv2(t('errors.notImplemented', { cmd: '/' + spec.name })));
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

    case 'project':
      await handleProject(user, machine, args, locale);
      return;

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
      const cancelled = await db.cancelCommand(job.id);
      if (!cancelled) {
        // Job keburu diambil add-in di antara pencarian dan pembatalan.
        await sendMessage(chatId, mdv2(t('admin.notCancellable')));
        return;
      }
      // Yang membatalkan adalah admin, tapi yang menunggu "⏳" adalah pemilik
      // job. Tanpa baris ini, pesannya menggantung selamanya di chat orang lain.
      await closeInChat(cancelled, 'common.cancelled');
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

  // Permintaan per-grup TIDAK bisa dibatasi di sini, dan pemeriksaan di atas
  // memberi kesan sebaliknya.
  //
  // Yang dihitungnya adalah panjang daftar sheet yang DIKETIK user. `/pdf
  // --series GENERAL` cuma satu kata, jadi `views.length` nol dan batasnya selalu
  // lolos — berapa pun isi grupnya. Selama batas itu hanya ada di sini, `--series`
  // adalah pintu yang melewatkan aturan yang seharusnya ditahan `maxSheets`:
  // viewer bisa menarik 18 sheet lewat celah yang menahannya di 10.
  //
  // Angkanya karena itu ikut ke dalam payload, dan add-in menegakkannya SETELAH
  // grupnya diterjemahkan jadi daftar sheet. Server tidak bisa mengerjakannya
  // sendiri: isi grup hanya ada di model, dan model hanya ada di PC itu.
  const byGroup = 'series' in built.payload || 'discipline' in built.payload;
  if (byGroup) built.payload.maxSheets = max;

  // Cooldown untuk command berat.
  if (HEAVY.includes(spec.name)) {
    const remaining = cooldownRemaining(await db.lastHeavyCommandAt(chatId, HEAVY));
    if (remaining > 0) {
      await sendMessage(chatId, mdv2(t('errors.cooldown', { seconds: remaining })));
      return;
    }
  }

  // Model yang aktif SAAT command dibuat ikut dibekukan ke dalam payload.
  // `machine/claim.ts` meneruskannya sebagai `expectedDocTitle`, dan add-in
  // menolak menjalankan job kalau model di Revit sudah berganti — tanpa ini
  // kamu bisa menerima PDF sheet LP-01 dari project yang berbeda, dan tidak ada
  // yang menandainya.
  //
  // Nilainya berasal dari heartbeat, yang disegarkan add-in tiap siklus polling
  // walau tidak ada job (lihat QueueWorker: ExternalEvent di-Raise setiap
  // siklus, justru supaya judul ini tidak basi). Kalau belum diketahui —
  // Revit baru dibuka dan heartbeat pertama belum masuk — kuncinya tidak
  // ditulis sama sekali, dan add-in melewati penjagaan ini.
  // Project yang dituju: pilihan user kalau ada, kalau tidak dokumen aktif.
  // Sebelum ada `/project`, yang menentukan selalu dokumen aktif — jadi orang
  // yang duduk di depan PC menentukan project siapa pun yang mengirim perintah
  // dari HP, dan si pengirim tidak punya cara melihat maupun mengubahnya.
  const target = targetProject(user, machine);
  const payload = target ? { ...built.payload, docTitle: target } : built.payload;

  const job = await db.insertCommand({
    chat_id: chatId,
    command: spec.name,
    payload,
    lang: locale,
  });

  // Pesan "⏳" disimpan message_id-nya supaya nanti di-EDIT, bukan ditimpa
  // pesan baru — riwayat chat tetap satu baris per perintah.
  //
  // Urutan pemeriksaannya penting: worker yang di-pause TIDAK mengambil job
  // walaupun PC-nya online, jadi "⏳ masuk antrean" saja akan terbaca sebagai
  // "sebentar lagi jalan" padahal tidak akan pernah — sampai ada yang /resume.
  const head = machine.is_paused
    ? t('errors.workerPaused')
    : isOnline(machine.last_seen_at)
      ? t('common.queued')
      : t('errors.pcOffline', {
          since: machine.last_seen_at ? absoluteTime(machine.last_seen_at, locale) : '—',
          ago: relativeTime(machine.last_seen_at, locale),
        });

  const sent = await sendMessage(chatId, mdv2(`${head}\n#${job.id.slice(0, 8)} /${spec.name}`));
  await db.setCommandMessageId(job.id, sent.message_id);
}

type Built = { payload: Record<string, unknown> } | { error: string };

function buildPayload(spec: CommandSpec, args: string[], locale: Locale): Built {
  const t = translator(locale);
  const example = spec.usage?.[locale] ?? `/${spec.name}`;
  // Pemisahan flag ada di commands.ts, bukan di sini: papan ketik ponsel
  // mengganti "--" jadi em dash otomatis, dan penanganannya harus berlaku untuk
  // semua flag sekaligus. Lihat catatan di `splitArgs`.
  const { positional, flags } = splitArgs(args);

  // Command yang menerima SATU nama menggabungkan kembali seluruh token.
  // Nama di proyek nyata mengandung spasi ("GROUND FLOOR", "PANEL SCHEDULE
  // DB-UTILTY"), dan karena tidak ada argumen kedua yang bisa direbut, tidak
  // ada yang hilang dengan menggabungkannya — sementara memakai token pertama
  // saja diam-diam membuang sisanya.
  const joined = positional.join(' ');

  switch (spec.name) {
    case 'levels':
    case 'warnings':
    case 'nwc':
    case 'ifc':
      return { payload: {} };

    // Daftar view 3D. Argumennya menyaring per nama; `--all` menampilkan
    // seluruh jenis view, bukan cuma yang 3D.
    case 'views':
      return { payload: { filter: joined || null, all: flags.includes('all') } };

    // Argumennya, kalau ada, menyaring per discipline: `/series F_UTILITY`.
    // `--detail` menambahkan nomor + nama tiap sheet di dalam grupnya.
    case 'series':
      return { payload: { groups: true, filter: joined || null, detail: flags.includes('detail') } };

    // `--groups` mendaftar grup ACT SHEET SERIES, bukan sheet satu per satu.
    // Nilai di belakangnya, kalau ada, menyaring per discipline.
    case 'sheets':
      if (flags.includes('groups') || flags.includes('grup')) {
        return { payload: { groups: true, filter: joined || null } };
      }
      return { payload: { filter: joined || null } };

    case 'count': {
      if (!positional.length) return { error: t('errors.missingArgs', { example }) };
      return {
        payload: {
          // `terms` yang dipakai add-in: ia punya daftar level DAN daftar
          // kategori model, jadi hanya ia yang bisa memutuskan di mana nama
          // level berakhir dan filter kategori dimulai. Server tidak bisa —
          // dan tebakannya ("token pertama = level, kedua = kategori") membuat
          // `/count GROUND FLOOR lighting` terbaca sebagai level "GROUND"
          // dengan kategori "FLOOR", lalu menjawab "tidak ada elemen MEP di
          // lantai ini" untuk lantai yang justru paling penuh.
          terms: positional,
          // Dipertahankan untuk add-in versi lama yang belum tahu `terms`.
          level: positional[0],
          category: positional[1] ?? null,
          detail: flags.includes('detail'),
          // Kolom Family&Type lengkap, ruangan, apparent load, dan nomor circuit
          // tidak mungkin muat di blok kode Telegram (52 karakter), jadi ia keluar
          // sebagai berkas. Add-in versi lama mengabaikan flag ini dan tetap
          // menjawab teks biasa — bukan gagal.
          csv: flags.includes('csv'),
        },
      };
    }

    // `--type` mengelompokkan per nama type Revit; tanpa itu per Comments.
    // Nilainya dikirim sebagai kata, bukan boolean, karena kunci ini sudah ada
    // sejak awal dengan nilai 'comments' — add-in lama yang mengabaikannya tetap
    // bekerja seperti sebelumnya.
    case 'tray':
      if (!joined) return { error: t('errors.missingArgs', { example }) };
      return { payload: { level: joined, groupBy: flags.includes('type') ? 'type' : 'comments' } };

    case 'load':
      if (!joined) return { error: t('errors.missingArgs', { example }) };
      return { payload: { level: joined } };

    case 'panel':
      if (!joined) return { error: t('errors.missingArgs', { example }) };
      return { payload: { panel: joined } };

    case 'find':
      if (!joined) return { error: t('errors.missingArgs', { example }) };
      return { payload: { mark: joined } };

    // Daftar sheet: spasi memisahkan, karena beberapa sheet boleh sekaligus.
    // Nomor sheet tidak mengandung spasi; kalau kamu memakai NAMA sheet yang
    // mengandung spasi, kutip: /pdf "GROUND & FIRST FLOOR"
    //
    // `--series` / `--disc` memilih per GRUP, bukan per sheet. Nama grupnya tidak
    // pernah diterjemahkan di sini: hanya add-in yang memegang model, jadi hanya
    // ia yang tahu satu grup berisi sheet apa saja. Server cuma meneruskan
    // katanya — dan ikut mengirim batas per role, karena batas di sini menghitung
    // panjang daftar sheet yang diketik user dan permintaan grup cuma satu kata.
    case 'pdf':
    case 'dwg': {
      if (flags.includes('series')) {
        if (!joined) return { error: t('errors.missingArgs', { example: `/${spec.name} --series "GENERAL-LV"` }) };
        return { payload: { series: joined } };
      }
      if (flags.includes('disc') || flags.includes('discipline')) {
        if (!joined) return { error: t('errors.missingArgs', { example: `/${spec.name} --disc F_UTILITY` }) };
        return { payload: { discipline: joined } };
      }
      if (!positional.length) return { error: t('errors.missingArgs', { example }) };
      return { payload: { views: positional } };
    }

    // Satu view saja, jadi seluruh token digabung — nama view hampir selalu
    // mengandung spasi ("GROUND & FIRST FLOOR - LIGHTING"), dan tidak ada
    // argumen kedua yang bisa direbut oleh penggabungan itu.
    // Boleh TANPA argumen: add-in menjawabnya dengan daftar view 3D yang ada.
    // Nama view di proyek nyata tidak bisa ditebak dan hanya tertulis di browser
    // tree Revit, jadi "argumen kurang" adalah jawaban yang benar untuk
    // pertanyaan yang salah — yang dibutuhkan orangnya justru daftar itu.
    case 'png':
      return { payload: { view: joined || null, views: joined ? [joined] : [], only3d: flags.includes('3d') } };

    case 'schedule':
      if (!joined) return { error: t('errors.missingArgs', { example }) };
      return { payload: { schedule: joined, format: 'csv' } };

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

  if (data.startsWith(PROJECT_PREFIX)) {
    const locale = resolveLocale(user.lang, query.from.language_code ?? null);
    await handleProjectCallback({ id: query.id, data, message: query.message }, user, locale);
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
