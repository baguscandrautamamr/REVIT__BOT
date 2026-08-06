/**
 * Penutup job yang tidak akan pernah selesai sendiri.
 *
 * Ada dua cara sebuah command mati diam-diam:
 *   1. `pending` lewat `expires_at` — Revit tidak pernah dibuka.
 *   2. `running` tapi tidak pernah dilaporkan — Revit ditutup di tengah jalan.
 *
 * Keduanya sudah ditandai di database sebelum ini, tapi TIDAK ADA yang
 * memberi tahu pemiliknya. Akibatnya pesan "⏳" di chat menggantung selamanya,
 * dan menunggu tidak bisa dibedakan dari bot yang rusak — persis kegagalan
 * senyap yang dihindari di seluruh repo ini.
 *
 * Penyapu dipanggil dari dua tempat supaya tidak ada celah:
 *   - `machine/claim.ts`   — tiap 4 detik, selama PC hidup
 *   - `telegram/webhook.ts` — tiap command, termasuk saat PC justru mati
 */
import * as db from './db';
import { translator } from './i18n';
import { MAX_RUNTIME_MS, ORPHAN_AFTER_MS, STUCK_AFTER_MS, isOnline } from './limits';
import { editMessageText, mdv2, sendMessage } from './telegram';

export interface SweepReport {
  expired: number;
  stuck: number;
}

/**
 * Apa yang diketahui pemanggil tentang keadaan add-in saat ini.
 *
 * `machine/claim.ts` tahu dua hal yang tidak bisa diketahui dari database:
 * add-in SEDANG memanggil (jadi ia hidup), dan `busy` — apakah ia masih memegang
 * sebuah job. `telegram/webhook.ts` tidak tahu keduanya dan mengirim objek kosong.
 */
export interface SweepContext {
  /** true/false dari heartbeat add-in; undefined = pemanggil tidak tahu. */
  addinBusy?: boolean;
}

/**
 * Berapa lama sebuah job `running` boleh hidup sebelum dianggap mati, dan
 * kenapa.
 *
 * Ini bagian yang sebelumnya salah, dan salahnya mahal. Dulu ambangnya SATU
 * angka — 15 menit — untuk dua keadaan yang sangat berbeda:
 *
 *   /pdf --disc pada 25 sheet A1 memang berjalan lebih dari 15 menit. Revit masih
 *   di 11%, add-in masih mengirim heartbeat tiap 4 detik, semuanya sehat — dan
 *   penyapu menutup job-nya dengan "Revit ditutup atau add-in berhenti".
 *   Pesannya bukan cuma tidak menolong, ia KELIRU, dan hasil belasan menit kerja
 *   Revit dibuang begitu tiba.
 *
 * Yang menentukan sekarang bukan lama, melainkan apakah masih ada yang
 * mengerjakannya:
 *
 *   add-in hidup + memegang job   → biarkan, sampai batas atas MAX_RUNTIME_MS
 *   add-in hidup + tidak memegang → terlantar; ORPHAN_AFTER_MS (2 menit)
 *   add-in tidak terlihat lagi    → mati bersama PC-nya; STUCK_AFTER_MS
 *
 * Baris kedua justru lebih CEPAT dari sebelumnya: add-in yang di-restart
 * ketahuan dalam dua menit, bukan lima belas, karena `busy` sudah mencakup job
 * yang masih menunggu di antrean internalnya.
 */
async function runningLimit(ctx: SweepContext): Promise<{ ms: number; reason: string }> {
  if (ctx.addinBusy === true) {
    return { ms: MAX_RUNTIME_MS, reason: 'add-in memegangnya terlalu lama' };
  }
  if (ctx.addinBusy === false) {
    return { ms: ORPHAN_AFTER_MS, reason: 'add-in tidak mengakui job ini' };
  }

  // Pemanggil tidak tahu keadaan add-in (jalur webhook). Heartbeat yang masih
  // segar sudah cukup untuk TIDAK menyimpulkan job-nya mati: /claim jalan tiap 4
  // detik dan akan memutuskannya dengan data yang benar.
  const machine = await db.getMachine();
  return isOnline(machine.last_seen_at)
    ? { ms: MAX_RUNTIME_MS, reason: 'berjalan terlalu lama' }
    : { ms: STUCK_AFTER_MS, reason: 'tidak ada laporan dari add-in' };
}

export async function sweepAndNotify(ctx: SweepContext = {}): Promise<SweepReport> {
  const limit = await runningLimit(ctx);

  const [expired, stuck] = await Promise.all([
    db.expireStale(),
    db.reapRunning(limit.ms, limit.reason),
  ]);

  await Promise.all([
    ...expired.map((job) => closeInChat(job, 'common.expired')),
    // Job yang dibunuh batas ATAS bukan job yang terputus — Revit-nya masih
    // hidup dan mungkin masih bekerja. Menyebutnya "Revit ditutup" akan
    // mengirim orang memeriksa PC yang sebenarnya tidak apa-apa.
    ...stuck.map((job) =>
      closeInChat(job, limit.ms === MAX_RUNTIME_MS ? 'errors.tooLong' : 'errors.stuck'),
    ),
  ]);

  return { expired: expired.length, stuck: stuck.length };
}

/** Versi yang tidak pernah melempar — untuk dipanggil di jalur command user. */
export async function sweepQuietly(ctx: SweepContext = {}): Promise<void> {
  try {
    await sweepAndNotify(ctx);
  } catch (err) {
    // Menyapu adalah kerja latar. Kalau gagal, command user tetap harus jalan.
    console.error('[sweep]', err);
  }
}

/**
 * Ubah pesan "⏳" milik job jadi status akhirnya. Kalau `tg_message_id` tidak
 * ada (pesan dihapus user, atau job dibuat sebelum message_id sempat disimpan),
 * kirim pesan baru — yang penting orangnya tahu.
 */
export async function closeInChat(job: db.CommandRow, key: string): Promise<void> {
  const t = translator(job.lang);
  const text = mdv2(`${t(key)}\n#${job.id.slice(0, 8)} /${job.command}`);

  try {
    if (job.tg_message_id) {
      await editMessageText(job.chat_id, job.tg_message_id, text);
    } else {
      await sendMessage(job.chat_id, text);
    }
  } catch (err) {
    // Pesan aslinya bisa saja sudah dihapus. Itu bukan alasan menjatuhkan
    // penyapuan job lain yang masih bisa diberitahukan.
    console.error(`[sweep] gagal mengabari job ${job.id}`, err);
  }
}
