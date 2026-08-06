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
import { STUCK_AFTER_MS } from './limits';
import { editMessageText, mdv2, sendMessage } from './telegram';

export interface SweepReport {
  expired: number;
  stuck: number;
}

export async function sweepAndNotify(): Promise<SweepReport> {
  const [expired, stuck] = await Promise.all([
    db.expireStale(),
    db.reapStuckRunning(STUCK_AFTER_MS),
  ]);

  await Promise.all([
    ...expired.map((job) => closeInChat(job, 'common.expired')),
    ...stuck.map((job) => closeInChat(job, 'errors.stuck')),
  ]);

  return { expired: expired.length, stuck: stuck.length };
}

/** Versi yang tidak pernah melempar — untuk dipanggil di jalur command user. */
export async function sweepQuietly(): Promise<void> {
  try {
    await sweepAndNotify();
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
