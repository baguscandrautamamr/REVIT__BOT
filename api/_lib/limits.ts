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
 * Job `running` yang belum melapor selewat ini dianggap mati.
 *
 * Lebih longgar dari `expires_at` (10 menit) karena job berat yang SEDANG
 * dikerjakan memang boleh lama — yang dibunuh di sini hanya yang tidak akan
 * pernah melapor lagi (Revit ditutup, add-in di-restart, PC mati).
 */
export const STUCK_AFTER_MS = 15 * 60 * 1000;

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
