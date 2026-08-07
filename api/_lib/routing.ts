/**
 * PC Revit mana yang melayani satu user.
 *
 * Dipisahkan dari `db.ts` karena isinya KEPUTUSAN, bukan pembacaan: arti "user
 * belum dipasangkan ke PC" berubah tergantung berapa PC yang terdaftar, dan
 * aturannya harus ada di satu tempat supaya webhook, panel, dan penyapu tidak
 * masing-masing menebaknya.
 *
 * ── Tiga keadaan, dan tidak satu pun yang jadi jurang ──────────────────────
 *
 *   0 PC terdaftar  → `legacy`. Semua dibaca dari `machine_state` dan job tidak
 *                     dialamatkan. Persis perilaku sebelum tabel `machines` ada.
 *
 *   1 PC terdaftar  → `pc`. Semua job ke PC itu, tanpa perlu satu penugasan pun
 *                     diisi. Ini yang membuat pemasangan tidak punya langkah
 *                     "sekarang semuanya berhenti sampai admin menugaskan semua
 *                     orang": selama masih satu PC, tidak ada yang bisa salah
 *                     pilih, jadi tidak ada yang perlu dipilih.
 *
 *   ≥2 PC terdaftar → user dengan penugasan dapat PC-nya; user TANPA penugasan
 *                     DITOLAK dengan kalimat beserta daftar PC yang ada.
 *
 * Keadaan ketiga itu yang paling penting, dan penolakannya disengaja. Menebak
 * salah satu PC berarti mengerjakan model orang lain lalu mengirimkannya sebagai
 * hasil yang sah — dan tidak ada apa pun di balasannya yang akan menandai bahwa
 * angka atau gambar kerja itu berasal dari project yang salah. Ditolak dengan
 * kalimat selalu lebih murah daripada berhasil dengan model yang salah.
 */
import * as db from './db';

export type Target =
  /** PC yang jelas. `machineId` null hanya mungkin di jalur `legacy`. */
  | { kind: 'pc'; view: db.MachineView; machineId: string }
  /** Belum ada PC terdaftar (atau migrasi 006 belum jalan) — perilaku lama. */
  | { kind: 'legacy'; view: db.MachineView }
  /** Lebih dari satu PC, dan user ini belum dipasangkan ke salah satunya. */
  | { kind: 'unassigned'; choices: db.Machine[] };

export async function targetFor(user: db.BotUser): Promise<Target> {
  // Tanpa kolom `machine_id`, tidak ada yang bisa diarahkan — apa pun isi tabel
  // `machines`. Membaca dari baris-baris itu tanpa bisa MENULIS tujuannya ke job
  // hanya akan membuat /status melapor tentang PC yang belum tentu mengerjakannya.
  if (!(await db.routingReady())) {
    return { kind: 'legacy', view: db.viewOfState(await db.getMachine()) };
  }

  const active = (await db.listMachines()).filter((m) => m.is_active);
  if (active.length === 0) {
    return { kind: 'legacy', view: db.viewOfState(await db.getMachine()) };
  }

  if (user.machine_id) {
    const mine = active.find((m) => m.id === user.machine_id);
    // Penugasan yang menunjuk PC yang sudah dicabut TIDAK jatuh ke PC terdekat:
    // ia turun ke aturan di bawah, dan kalau ada beberapa PC, dijawab dengan
    // daftar. Memindahkannya diam-diam adalah cara mengerjakan model yang salah
    // tanpa satu pun tanda.
    if (mine) return { kind: 'pc', view: db.viewOfMachine(mine), machineId: mine.id };
  }

  if (active.length === 1) {
    const only = active[0]!;
    return { kind: 'pc', view: db.viewOfMachine(only), machineId: only.id };
  }

  return { kind: 'unassigned', choices: active };
}

/**
 * Petak antrean yang dilihat sebuah target — untuk /status, /queue, dan penyapu.
 *
 * `legacy` mengembalikan undefined, bukan `{ machineId: null }`: yang pertama
 * berarti "jangan filter apa pun", yang kedua berarti "hanya job tanpa tujuan".
 * Di era sebelum routing, semua job memang tanpa tujuan sehingga keduanya
 * kebetulan sama — tapi begitu ada satu job yang dialamatkan, keduanya berbeda,
 * dan yang salah menyembunyikan job dari /status pemiliknya.
 */
export function scopeOf(target: Target): { machineId: string | null } | undefined {
  if (target.kind === 'pc') return { machineId: target.machineId };
  return undefined;
}
