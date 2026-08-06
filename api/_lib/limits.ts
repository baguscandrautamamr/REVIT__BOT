import type { Role } from './db';

/**
 * Batas per role. Ditegakkan di server — bukan di menu Telegram dan bukan di
 * add-in. Menyembunyikan command dari menu hanya kosmetik: viewer tetap bisa
 * mengetik `/ifc` manual.
 */
export const LIMITS: Record<Role, { maxSheets: number; blocked: string[] }> = {
  viewer: { maxSheets: 10, blocked: ['ifc', 'nwc', 'dwg', 'setparam', 'tag', 'dynamo'] },
  admin: { maxSheets: 999, blocked: [] },
};

/** Command yang memakan Revit lama — memicu cooldown. */
export const HEAVY = ['pdf', 'ifc', 'nwc', 'dwg', 'png'];

export const COOLDOWN_MS = 2 * 60 * 1000;

/** Sisa cooldown dalam detik; 0 kalau sudah boleh. */
export function cooldownRemaining(lastHeavyAt: Date | null): number {
  if (!lastHeavyAt) return 0;
  const elapsed = Date.now() - lastHeavyAt.getTime();
  return elapsed >= COOLDOWN_MS ? 0 : Math.ceil((COOLDOWN_MS - elapsed) / 1000);
}

/** PC dianggap online kalau claim terakhir < 30 detik lalu (polling 4 detik). */
export const ONLINE_WINDOW_MS = 30_000;

export function isOnline(lastSeenAt: string | null): boolean {
  return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

/**
 * Job `running` dianggap mati kalau PC-nya TIDAK terlihat lagi selewat ini.
 *
 * Berlaku hanya saat heartbeat berhenti — Revit ditutup, add-in di-restart, PC
 * mati. Selama heartbeat masih masuk, angka ini tidak dipakai sama sekali; lihat
 * `MAX_RUNTIME_MS`.
 */
export const STUCK_AFTER_MS = 15 * 60 * 1000;

/**
 * Batas ATAS lama satu job, dipakai walau add-in bilang masih mengerjakannya.
 *
 * Ada karena "add-in masih hidup" bukan jaminan job-nya akan selesai: satu
 * dialog Revit yang tidak tertangkap DialogSuppressor bisa menggantung main
 * thread selamanya, dan tanpa batas atas pesan "⏳" milik user tidak pernah
 * berubah. Dua jam sengaja jauh di atas export terberat yang masuk akal —
 * batas ini jaring terakhir, bukan penjadwal.
 */
export const MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;

/**
 * Job `running` yang TIDAK diakui add-in dianggap terlantar selewat ini.
 *
 * Sinyal yang jauh lebih tajam daripada timer: add-in mengirim `busy` di setiap
 * heartbeat, dan `busy` mencakup job yang masih di antrean internalnya. Jadi
 * "PC hidup, tapi tidak sedang memegang job apa pun, padahal ada baris
 * `running`" berarti job itu hilang bersama restart add-in — dan itu bisa
 * diketahui dalam dua menit, bukan lima belas.
 *
 * Tidak nol karena ada jeda wajar antara server menandai `running` dan add-in
 * menerima balasan claim lalu memasukkannya ke antrean.
 */
export const ORPHAN_AFTER_MS = 2 * 60 * 1000;

/**
 * Selisih zona waktu kantor terhadap UTC, dalam menit. Default +07:00 (WIB).
 *
 * Fungsi Vercel berjalan di UTC, jadi "hari ini" versi server berganti jam
 * 07:00 WIB — hitungan "selesai hari ini" akan mereset di tengah pagi kerja
 * dan terlihat seperti angka yang hilang.
 */
export const UTC_OFFSET_MINUTES = Number(process.env.UTC_OFFSET_MINUTES ?? 420);

/** Tengah malam waktu kantor, dinyatakan sebagai Date absolut. */
export function startOfLocalDay(now: Date = new Date()): Date {
  const offsetMs = UTC_OFFSET_MINUTES * 60_000;
  const shifted = new Date(now.getTime() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMs);
}
