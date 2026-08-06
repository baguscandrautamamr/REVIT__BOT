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
