/**
 * POST /api/machine/report — add-in melapor hasil satu job.
 *
 * Body:
 * {
 *   "id": "uuid",
 *   "ok": true,
 *   "docTitle": "PRJ-B.rvt",
 *   "text": "Lampu 184\n…",                    // opsional
 *   "error": "…",                              // saat ok=false
 *   "file": { "name": "…pdf", "base64": "…" }  // opsional, ≤ 50 MB
 * }
 *
 * Hasilnya meng-EDIT pesan "⏳" yang sudah ada, bukan mengirim pesan baru.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

import * as db from '../_lib/db';
import { ENV } from '../_lib/env';
import { translator } from '../_lib/i18n';
import { durationText, resultBlocks } from '../_lib/reply';
import {
  MAX_TEXT,
  chunk,
  editMessageText,
  mdv2,
  sendDocument,
  sendMessage,
} from '../_lib/telegram';

/** Batas upload bot Telegram. Di atas ini harus lewat Storage + signed URL. */
const MAX_UPLOAD = 50 * 1024 * 1024;

/**
 * Pesan error Revit dipotong sebelum masuk judul balasan. Stack trace panjang
 * tidak menolong siapa pun di chat, dan judul yang membengkak justru mendorong
 * seluruh pesan melewati batas Telegram.
 */
const MAX_ERROR_CHARS = 500;

/** Di bawah ini, lama eksekusi tidak disebut — hanya menambah bising. */
const SLOW_ENOUGH_MS = 10_000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const body = (req.body ?? {}) as {
    id?: string;
    ok?: boolean;
    docTitle?: string | null;
    text?: string;
    error?: string;
    file?: { name: string; base64: string };
    elapsedMs?: number;
  };

  if (!body.id) return res.status(400).json({ error: 'id required' });

  try {
    const job = await db.getCommand(body.id);
    if (!job) return res.status(404).json({ error: 'not found' });

    const ok = body.ok !== false;
    const updated = await db.finishCommand(job.id, {
      status: ok ? 'done' : 'failed',
      result: ok ? { ok: true, text: body.text ?? '' } : null,
      error: ok ? null : (body.error ?? 'unknown'),
      doc_title: body.docTitle ?? null,
    });

    // `finishCommand` hanya menutup job yang masih `running`. Kalau ia
    // mengembalikan null, job ini sudah ditutup lebih dulu — laporan ganda dari
    // add-in, atau penyapu keburu menandainya "stuck". Berhenti di sini: user
    // sudah menerima balasan, dan meneruskan berarti mengedit pesannya dua kali
    // sekaligus mengirim filenya dua kali.
    if (!updated) {
      console.warn(`[report] job ${job.id} sudah tertutup (${job.status}) — laporan diabaikan`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const locale = job.lang;
    const t = translator(locale);
    let head = ok
      ? t('common.done')
      : t('errors.revitError', { message: (body.error ?? '—').slice(0, MAX_ERROR_CHARS) });

    // Lama eksekusi hanya disebut kalau memang terasa lama. Menempelkan
    // "Waktu proses: 1 detik" ke setiap /levels cuma menambah bising.
    const elapsed = body.elapsedMs ?? 0;
    if (elapsed >= SLOW_ENOUGH_MS) {
      head += ` · ${t('common.elapsed', { duration: durationText(elapsed, locale) })}`;
    }

    await deliver(job, compose(mdv2(head), ok ? resultBlocks(updated.result) : []));

    if (ok && body.file?.base64) {
      const bytes = Buffer.from(body.file.base64, 'base64');
      if (bytes.byteLength > MAX_UPLOAD) {
        await sendMessage(
          job.chat_id,
          mdv2(
            t('errors.fileTooBig', {
              size: (bytes.byteLength / 1024 / 1024).toFixed(1),
              url: '—',
            }),
          ),
        );
      } else {
        await sendDocument(job.chat_id, { name: body.file.name, bytes });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[report]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

/**
 * Judul + blok hasil → daftar pesan yang setiap anggotanya muat di Telegram.
 *
 * Blok pertama digabung ke judul kalau masih muat, supaya hasil pendek — yang
 * merupakan mayoritas — tetap menjadi SATU pesan seperti sebelumnya.
 */
function compose(headMd: string, blocks: string[]): string[] {
  const parts = chunk(headMd);
  const last = parts[parts.length - 1] ?? '';
  const first = blocks[0];

  if (first && last.length + 1 + first.length <= MAX_TEXT) {
    parts[parts.length - 1] = `${last}\n${first}`;
    return parts.concat(blocks.slice(1));
  }
  return parts.concat(blocks);
}

/**
 * Kirim balasan hasil job.
 *
 * Bagian pertama MENGGANTIKAN pesan "⏳" yang sudah ada — riwayat chat tetap
 * satu baris per perintah. Sisanya menyusul sebagai pesan baru.
 *
 * Tidak satu pun kegagalan di sini boleh melempar keluar: barisnya sudah
 * ditandai selesai di database, jadi 500 ke add-in hanya menghasilkan laporan
 * yang tidak bisa diulang, dan pesan "⏳" akan menggantung sampai disapu 15
 * menit kemudian sebagai "stuck" — padahal Revit sudah menyelesaikan kerjanya.
 */
async function deliver(job: db.CommandRow, parts: string[]): Promise<void> {
  const [first, ...rest] = parts;
  if (!first) return;

  let delivered = false;
  if (job.tg_message_id) {
    try {
      await editMessageText(job.chat_id, job.tg_message_id, first);
      delivered = true;
    } catch (err) {
      // Pesan aslinya bisa saja sudah dihapus user.
      console.error('[report] edit pesan gagal', err);
    }
  }

  if (!delivered) {
    try {
      await sendMessage(job.chat_id, first);
    } catch (err) {
      // Usaha terakhir, teks polos tanpa MarkdownV2: kalau yang menggagalkan
      // justru escaping, pesan pengganti tidak boleh ikut gagal karena alasan
      // yang sama.
      console.error('[report] kirim gagal, jatuh ke teks polos', err);
      try {
        await sendMessage(job.chat_id, plain(first), { parse_mode: undefined });
      } catch (lastErr) {
        console.error('[report] teks polos pun gagal', lastErr);
      }
    }
  }

  for (const part of rest) {
    try {
      await sendMessage(job.chat_id, part);
    } catch (err) {
      // Satu potongan yang gagal tidak boleh menghentikan sisanya.
      console.error('[report] potongan lanjutan gagal', err);
    }
  }
}

/** MarkdownV2 → teks biasa: buang pagar blok kode dan escape-nya. */
function plain(md: string): string {
  return md.replace(/```/g, '').replace(/\\(.)/g, '$1').trim().slice(0, MAX_TEXT);
}

function authorized(req: VercelRequest): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !ENV.machineToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(ENV.machineToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** File PDF besar dikirim sebagai base64 — naikkan batas body dari 1 MB. */
export const config = { api: { bodyParser: { sizeLimit: '70mb' } } };
