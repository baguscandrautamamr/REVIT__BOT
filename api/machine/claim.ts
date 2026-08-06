/**
 * POST /api/machine/claim — dipanggil add-in tiap 4 detik.
 *
 * Merangkap heartbeat: claim tetap masuk walaupun tidak ada job, jadi server
 * tahu PC hidup tanpa perlu endpoint terpisah.
 *
 * Body:  { activeDoc, revitVersion, addinVersion }
 * Balas: { job: {...} | null, paused: boolean }
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from '../_lib/db';
import { authorized } from '../_lib/machineauth';
import { sweepQuietly } from '../_lib/sweep';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const body = (req.body ?? {}) as {
    activeDoc?: string | null;
    revitVersion?: string | null;
    addinVersion?: string | null;
    busy?: boolean;
  };

  try {
    await db.updateMachine({
      last_seen_at: new Date().toISOString(),
      active_doc: body.activeDoc ?? null,
      revit_version: body.revitVersion ?? null,
      addin_version: body.addinVersion ?? null,
    });

    // Bersihkan yang sudah lewat expires_at sebelum mengambil job baru,
    // supaya command basi tidak tiba-tiba jalan setelah Revit dibuka lagi.
    // Sekaligus menutup job `running` yang ditinggal mati — dan yang penting,
    // memberi tahu pemiliknya, bukan cuma mengubah baris di database.
    await sweepQuietly();

    const machine = await db.getMachine();
    if (machine.is_paused || !machine.bot_enabled) {
      return res.status(200).json({ job: null, paused: true });
    }

    // Add-in masih mengerjakan job sebelumnya di main thread Revit. Heartbeat
    // di atas sudah dicatat — itu justru tujuan panggilan ini — tapi memberi
    // job kedua akan membuat hasilnya saling menimpa.
    if (body.busy === true) {
      return res.status(200).json({ job: null, paused: false, busy: true });
    }

    const job = await db.claimNextCommand();
    if (!job) return res.status(200).json({ job: null, paused: false });

    return res.status(200).json({
      job: {
        id: job.id,
        command: job.command,
        payload: job.payload,
        lang: job.lang,
        expectedDocTitle: (job.payload as { docTitle?: string }).docTitle ?? null,
      },
      paused: false,
    });
  } catch (err) {
    console.error('[claim]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

