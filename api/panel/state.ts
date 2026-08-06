/**
 * GET /api/panel/state — data untuk panel web (web/index.html).
 *
 * Otorisasi: header `x-telegram-init-data` diverifikasi HMAC (lihat
 * `verifyInitData`). Tanpa initData yang sah, endpoint menolak — panel
 * hanya boleh dibuka dari dalam Telegram oleh user terdaftar.
 *
 * Respons ikut membawa `lang` dan `theme` milik user supaya panel bisa
 * memakai preferensi yang sama dengan chat pada pembukaan pertama.
 */
import { verifyInitData } from '../_lib/telegram';
import { resolveLocale } from '../_lib/i18n';

export const config = { runtime: 'nodejs' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'method' }, 405);

  const auth = verifyInitData(req.headers.get('x-telegram-init-data') ?? '');
  if (!auth.ok) return json({ error: 'unauthorized', reason: auth.reason }, 401);

  const user = await getUser(auth.user.id);
  if (!user || !user.is_active) return json({ error: 'not_registered' }, 403);

  const machine = await getMachineState();
  const queue = await getQueueSummary();

  const lastSeen = machine.last_seen_at ? new Date(machine.last_seen_at) : null;
  // PC dianggap online kalau claim terakhir < 30 detik lalu.
  // Polling 4 detik → 30 detik memberi ruang untuk beberapa kali gagal
  // tanpa panel berkedip merah setiap kali wifi tersendat.
  const online = !!lastSeen && Date.now() - lastSeen.getTime() < 30_000;

  return json({
    role: user.role,
    lang: user.lang,
    locale: resolveLocale(user.lang, auth.user.language_code),
    theme: user.theme,
    online,
    isPaused: machine.is_paused,
    botEnabled: machine.bot_enabled,
    lastSeenAt: machine.last_seen_at,
    activeDoc: machine.active_doc,
    revitVersion: machine.revit_version,
    addinVersion: machine.addin_version,
    queue,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ── Diimplementasi di _lib/supabase.ts ────────────────────────────────────
declare function getUser(chatId: number): Promise<
  { role: 'viewer' | 'admin'; lang: 'auto' | 'id' | 'en'; theme: 'auto' | 'light' | 'dark'; is_active: boolean } | null
>;
declare function getMachineState(): Promise<{
  last_seen_at: string | null;
  active_doc: string | null;
  revit_version: string | null;
  addin_version: string | null;
  is_paused: boolean;
  bot_enabled: boolean;
}>;
declare function getQueueSummary(): Promise<{
  pending: { command: string; createdAt: string; status: string }[];
  running: { command: string; createdAt: string; status: string }[];
  doneToday: number;
}>;
