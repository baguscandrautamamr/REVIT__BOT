/**
 * GET /api/panel/state — data untuk panel web (web/index.html).
 *
 * Otorisasi: header `x-telegram-init-data` diverifikasi HMAC. Panel hanya
 * boleh dibuka dari dalam Telegram oleh user terdaftar.
 *
 * Respons ikut membawa `lang` dan `theme` milik user supaya panel memakai
 * preferensi yang sama dengan chat pada pembukaan pertama.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from '../_lib/db';
import { resolveLocale } from '../_lib/i18n';
import { isOnline } from '../_lib/limits';
import { verifyInitData } from '../_lib/telegram';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const raw = req.headers['x-telegram-init-data'];
  const initData = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  const auth = verifyInitData(initData);
  if (!auth.ok) return res.status(401).json({ error: 'unauthorized', reason: auth.reason });

  try {
    const user = await db.getUser(auth.user.id);
    if (!user || !user.is_active) return res.status(403).json({ error: 'not_registered' });

    const [machine, queue] = await Promise.all([db.getMachine(), db.queueSnapshot()]);

    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({
      // Panel memakainya untuk mengenali barisnya sendiri di daftar user —
      // admin tidak boleh diberi tombol yang mencabut aksesnya sendiri.
      chatId: user.chat_id,
      role: user.role,
      lang: user.lang,
      locale: resolveLocale(user.lang, auth.user.language_code),
      theme: user.theme,
      online: isOnline(machine.last_seen_at),
      isPaused: machine.is_paused,
      botEnabled: machine.bot_enabled,
      lastSeenAt: machine.last_seen_at,
      activeDoc: machine.active_doc,
      revitVersion: machine.revit_version,
      addinVersion: machine.addin_version,
      queue: {
        pending: queue.pending.map(slim),
        running: queue.running.map(slim),
        doneToday: queue.doneToday,
      },
    });
  } catch (err) {
    console.error('[panel/state]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

function slim(job: db.CommandRow) {
  return { command: job.command, createdAt: job.created_at, status: job.status };
}
