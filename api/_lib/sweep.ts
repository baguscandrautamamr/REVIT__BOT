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
 *
 * ── Kenapa sekarang PER-PC ──────────────────────────────────────────────────
 *
 * Dengan lebih dari satu PC Revit, satu keputusan untuk seluruh antrean menjadi
 * salah dengan cara yang mahal: /claim dari PC yang idle melaporkan `busy: false`,
 * dan tanpa pembatasan itu berarti "tidak ada yang mengerjakan job apa pun" —
 * lalu job PC LAIN yang sedang mengekspor 25 sheet ditutup dengan alasan "add-in
 * tidak mengakui job ini". Benar untuk PC pemanggil, salah untuk pemilik job-nya,
 * dan hasil belasan menit kerja Revit dibuang tepat sebelum tiba.
 *
 * Jadi penyapuan sekarang dijalankan sebagai beberapa PASS, satu per PC, dan tiap
 * pass hanya menyentuh job miliknya sendiri.
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
  /**
   * PC yang sedang memanggil, dari jalur /claim, beserta apa yang ia ketahui.
   * Tidak ada = jalur webhook: tidak tahu PC mana, dan tidak tahu `busy`.
   *
   * `machineId: null` berarti pemanggilnya memakai `MACHINE_TOKEN` dari
   * environment — ia tidak punya identitas, jadi yang boleh disapunya hanya job
   * yang juga tidak dialamatkan.
   *
   * `addinBusy` SENGAJA berada di dalam sini, bukan sebagai bidang sejajar.
   * Bentuk sebelumnya mengizinkan `{ addinBusy: false }` tanpa menyebut PC-nya —
   * dan dengan beberapa PC, itu berarti "satu PC yang idle menyatakan tidak ada
   * yang mengerjakan job apa pun", lalu job PC lain yang justru sedang mengekspor
   * ditutup sebagai terlantar. Keadaan yang tidak punya arti yang benar sebaiknya
   * tidak bisa ditulis sama sekali.
   */
  caller?: { machineId: string | null; addinBusy?: boolean };
}

/**
 * Satu putaran penyapuan atas satu petak antrean.
 *
 * `scope` undefined berarti "seluruh antrean" dan hanya dipakai di jalur lama
 * (belum ada PC terdaftar). Membedakannya dari `{ machineId: null }` itu penting:
 * yang kedua berarti "hanya job tanpa tujuan", dan memakainya untuk jalur lama
 * akan meninggalkan job yang dialamatkan tanpa satu pun penyapu.
 */
interface Pass {
  scope: { machineId: string | null } | undefined;
  /** Dasar penilaian "PC-nya masih hidup?" untuk pass ini. */
  lastSeenAt: string | null;
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
interface RunningLimit {
  ms: number;
  /** Masuk ke kolom `error` — dibaca manusia yang menengok database. */
  reason: string;
  /**
   * Kunci katalog untuk pesan ke chat.
   *
   * Dibawa sebagai KUNCI, bukan disimpulkan dari `ms`. Menyimpulkannya berarti
   * membandingkan angka untuk mencari tahu maksud — dan begitu ada ambang ketiga
   * yang nilainya kebetulan sama, user menerima kalimat dari cabang yang salah
   * tanpa satu pun test yang berubah warna.
   */
  message: 'errors.stuck' | 'errors.tooLong';
}

function runningLimit(pass: Pass): RunningLimit {
  if (pass.addinBusy === true) {
    return {
      ms: MAX_RUNTIME_MS,
      reason: 'add-in memegangnya terlalu lama',
      message: 'errors.tooLong',
    };
  }
  if (pass.addinBusy === false) {
    return {
      ms: ORPHAN_AFTER_MS,
      reason: 'add-in tidak mengakui job ini',
      message: 'errors.stuck',
    };
  }

  // Pemanggil tidak tahu keadaan add-in (jalur webhook). Heartbeat yang masih
  // segar sudah cukup untuk TIDAK menyimpulkan job-nya mati: /claim jalan tiap 4
  // detik dan akan memutuskannya dengan data yang benar.
  return isOnline(pass.lastSeenAt)
    ? { ms: MAX_RUNTIME_MS, reason: 'berjalan terlalu lama', message: 'errors.tooLong' }
    : { ms: STUCK_AFTER_MS, reason: 'tidak ada laporan dari add-in', message: 'errors.stuck' };
}

/**
 * Susun daftar pass.
 *
 * Dari /claim: satu pass saja, untuk PC pemanggil. `lastSeenAt` diisi waktu
 * sekarang — PC itu sedang menelepon, jadi ia jelas hidup, dan membacanya dari
 * database malah bisa memakai nilai yang belum ter-update.
 *
 * Dari webhook: satu pass per PC terdaftar, PLUS satu pass untuk job yang belum
 * dialamatkan. Pass terakhir itu memakai heartbeat `machine_state`, yang tetap
 * ditulis setiap /claim dari PC mana pun — dan itu memang sinyal yang benar untuk
 * job dari era sebelum routing ada.
 */
async function passesFor(ctx: SweepContext): Promise<Pass[]> {
  if (ctx.caller) {
    const { machineId, addinBusy } = ctx.caller;
    return [{
      scope: (await db.routingReady()) ? { machineId } : undefined,
      lastSeenAt: new Date().toISOString(),
      addinBusy,
    }];
  }

  const state = await db.getMachine();

  if (!(await db.routingReady())) {
    return [{ scope: undefined, lastSeenAt: state.last_seen_at }];
  }

  const machines = await db.listMachines();
  if (machines.length === 0) {
    return [{ scope: undefined, lastSeenAt: state.last_seen_at }];
  }

  return [
    ...machines.map((m) => ({
      scope: { machineId: m.id },
      lastSeenAt: m.last_seen_at,
    })),
    { scope: { machineId: null }, lastSeenAt: state.last_seen_at },
  ];
}

export async function sweepAndNotify(ctx: SweepContext = {}): Promise<SweepReport> {
  // Kedaluwarsa dinilai dari `expires_at`, jadi ia tidak punya urusan dengan PC
  // mana pun dan dikerjakan SEKALI. Menjalankannya per pass akan mengulang
  // pekerjaan yang sama sebanyak jumlah PC, dan yang kedua dan seterusnya selalu
  // mendapat nol baris.
  const expired = await db.expireStale();
  await Promise.all(expired.map((job) => closeInChat(job, 'common.expired')));

  let stuck = 0;
  for (const pass of await passesFor(ctx)) {
    const limit = runningLimit(pass);
    const reaped = await db.reapRunning(limit.ms, limit.reason, pass.scope);

    // Job yang dibunuh batas ATAS bukan job yang terputus — Revit-nya masih
    // hidup dan mungkin masih bekerja. Menyebutnya "Revit ditutup" akan
    // mengirim orang memeriksa PC yang sebenarnya tidak apa-apa.
    await Promise.all(reaped.map((job) => closeInChat(job, limit.message)));
    stuck += reaped.length;
  }

  return { expired: expired.length, stuck };
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
