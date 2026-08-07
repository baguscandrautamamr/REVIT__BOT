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
import { scopeOf, targetFor } from '../_lib/routing';
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

    // Keadaan PC MILIK USER INI, bukan gabungan semua PC. Angka gabungan akan
    // membuat orang mengira job-nya menunggu di belakang pekerjaan yang
    // sebenarnya berjalan di mesin lain.
    const target = await targetFor(user);
    const view = target.kind === 'unassigned' ? null : target.view;

    const [state, queue] = await Promise.all([
      db.getMachine(),
      db.queueSnapshot(scopeOf(target)),
    ]);

    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({
      // Panel memakainya untuk mengenali barisnya sendiri di daftar user —
      // admin tidak boleh diberi tombol yang mencabut aksesnya sendiri.
      chatId: user.chat_id,
      role: user.role,
      lang: user.lang,
      locale: resolveLocale(user.lang, auth.user.language_code),
      theme: user.theme,
      online: isOnline(view?.last_seen_at ?? null),
      isPaused: view?.is_paused ?? false,
      // GLOBAL, bukan per-PC: kill switch untuk semua PC sekaligus.
      botEnabled: state.bot_enabled,
      lastSeenAt: view?.last_seen_at ?? null,
      activeDoc: view?.active_doc ?? null,
      revitVersion: view?.revit_version ?? null,
      addinVersion: view?.addin_version ?? null,
      // Nama PC hanya ada kalau ia punya barisnya sendiri; panel memakainya
      // untuk menyebut status ini milik PC yang mana.
      pcName: view?.id ? view.name : null,
      // Lebih dari satu PC terdaftar dan user ini belum dipasangkan ke salah
      // satunya. Panel harus MENGATAKANNYA, bukan menampilkan status kosong yang
      // tidak bisa dibedakan dari PC yang mati.
      unassigned: target.kind === 'unassigned',
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
