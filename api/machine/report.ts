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
 *   "elapsedMs": 184000,                       // lama proses di Revit
 *
 *   // Berkas hasil, salah satu bentuk:
 *   "file": { "name": "…pdf", "base64": "…" }        // ≤ 3 MB, ikut di body
 *   "file": { "name": "…pdf", "storagePath": "…" }   // > 3 MB, sudah diunggah
 *   "fileError": "…"                                 // add-in gagal menyiapkannya
 * }
 *
 * Hasilnya meng-EDIT pesan "⏳" yang sudah ada, bukan mengirim pesan baru.
 *
 * Body request ke Serverless Function Vercel dibatasi 4,5 MB oleh PLATFORM —
 * batas keras yang tidak bisa dinaikkan dari kode. Itu sebabnya berkas besar
 * tidak lewat sini sama sekali; add-in mengunggahnya langsung ke Supabase
 * Storage dan endpoint ini hanya menerima path-nya. Lihat api/_lib/storage.ts.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from '../_lib/db';
import { translator } from '../_lib/i18n';
import { authorized } from '../_lib/machineauth';
import * as storage from '../_lib/storage';
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
    // `base64` hanya untuk berkas kecil. Yang besar diunggah add-in langsung
    // ke Supabase Storage dan diwakili `storagePath` — body request ke fungsi
    // Vercel dibatasi 4,5 MB oleh platform, jadi PDF sungguhan tidak akan
    // pernah muat di sini. Lihat api/_lib/storage.ts.
    file?: { name: string; base64?: string; storagePath?: string };
    /** Add-in gagal menyiapkan/mengunggah berkasnya. Wajib sampai ke user. */
    fileError?: string;
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

    // Berkas ditangani SETELAH balasan teks terkirim, dan kegagalannya tidak
    // pernah menjatuhkan request ini. Barisnya sudah ditandai selesai; menjawab
    // 500 di sini hanya menghasilkan laporan yang tidak bisa diulang, dan user
    // kembali menatap "⏳" untuk kerja Revit yang sebenarnya sudah rampung.
    let fileNote: string | null = body.fileError ?? null;
    if (ok && body.file && !fileNote) {
      fileNote = await sendResultFile(job, body.file, t);
    }
    if (fileNote) {
      try {
        await sendMessage(job.chat_id, mdv2(t('errors.fileFailed', { reason: fileNote })));
      } catch (err) {
        console.error('[report] gagal mengabari kegagalan berkas', err);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[report]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

/**
 * Kirim berkas hasil ke Telegram. Mengembalikan null kalau berhasil, atau
 * alasan yang bisa dibaca orang kalau tidak — dan alasan itu WAJIB sampai ke
 * chat. Berkas yang gagal tanpa sepatah kata pun adalah persis kegagalan yang
 * membuat /pdf terlihat "masih jalan" selama belasan menit.
 */
async function sendResultFile(
  job: db.CommandRow,
  file: { name: string; base64?: string; storagePath?: string },
  t: ReturnType<typeof translator>,
): Promise<string | null> {
  let bytes: Buffer;

  try {
    if (file.storagePath) {
      bytes = await storage.download(file.storagePath);
    } else if (file.base64) {
      bytes = Buffer.from(file.base64, 'base64');
    } else {
      return 'add-in tidak menyertakan isi berkasnya';
    }
  } catch (err) {
    console.error('[report] ambil berkas gagal', err);
    return err instanceof Error ? err.message.slice(0, 300) : 'tidak bisa mengambil berkas';
  }

  try {
    if (bytes.byteLength > MAX_UPLOAD) {
      return t('errors.fileTooBig', {
        size: (bytes.byteLength / 1024 / 1024).toFixed(1),
        url: '—',
      });
    }
    await sendDocument(job.chat_id, { name: file.name, bytes });
    return null;
  } catch (err) {
    console.error('[report] sendDocument gagal', err);
    return err instanceof Error ? err.message.slice(0, 300) : 'Telegram menolak berkasnya';
  } finally {
    // Persinggahan, bukan arsip. Dihapus baik berhasil maupun tidak — kalau
    // gagal, mengulang command lebih murah daripada menumpuk PDF di storage.
    if (file.storagePath) await storage.remove(file.storagePath);
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

/**
 * Naikkan batas parser dari 1 MB, untuk berkas KECIL yang masih dikirim inline.
 *
 * Angka ini sengaja di bawah batas platform Vercel (4,5 MB untuk body request
 * Serverless Function) — menaikkannya lebih tinggi tidak ada gunanya, sebab
 * yang menolak duluan adalah platformnya, dengan 413, sebelum satu baris
 * handler pun jalan. Berkas yang lebih besar TIDAK boleh lewat sini: ia
 * diunggah add-in langsung ke Supabase Storage. Lihat api/_lib/storage.ts.
 */
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };
