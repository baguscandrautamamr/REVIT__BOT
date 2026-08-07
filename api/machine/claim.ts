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
import { authorize } from '../_lib/machineauth';
import { sweepQuietly } from '../_lib/sweep';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const caller = await authorize(req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });

  const body = (req.body ?? {}) as {
    activeDoc?: string | null;
    revitVersion?: string | null;
    addinVersion?: string | null;
    busy?: boolean;
    /** Judul semua project yang terbuka. Kosong = add-in versi lama. */
    openDocs?: string[] | null;
  };

  try {
    // `open_docs` hanya ikut ditulis kalau kolomnya memang ada. Menyertakannya
    // tanpa migrasi 004 membuat PostgREST menolak SELURUH PATCH — dan yang mati
    // bukan cuma pilihan project, melainkan heartbeat: PC-nya langsung terbaca
    // offline dan tidak satu pun job pernah diambil lagi.
    const withProjects = await db.projectSelectionReady();
    const seenAt = new Date().toISOString();

    await db.updateMachine({
      last_seen_at: seenAt,
      active_doc: body.activeDoc ?? null,
      revit_version: body.revitVersion ?? null,
      addin_version: body.addinVersion ?? null,
      ...(withProjects ? { open_docs: body.openDocs ?? [] } : {}),
    });

    // Catatan KEDUA, dan urutannya disengaja: baris di `machines` hanya membuat
    // panel jujur tentang PC mana yang hidup. Yang benar-benar menentukan
    // — /status, /project, dan penyapu — tetap `machine_state` di atas.
    //
    // Tanpa baris ini, PC yang baru didaftarkan admin akan selamanya tampil
    // "belum pernah terlihat" di panel walaupun ia sedang polling tiap 4 detik,
    // dan itu kebohongan yang persis menghalangi satu-satunya kegunaan tabel itu
    // sekarang: memastikan token barunya benar-benar dipakai.
    if (caller.kind === 'row') {
      await db.touchMachine(caller.machine.id, {
        last_seen_at: seenAt,
        active_doc: body.activeDoc ?? null,
        revit_version: body.revitVersion ?? null,
        addin_version: body.addinVersion ?? null,
        open_docs: body.openDocs ?? [],
      });
    }

    // Bersihkan yang sudah lewat expires_at sebelum mengambil job baru,
    // supaya command basi tidak tiba-tiba jalan setelah Revit dibuka lagi.
    // Sekaligus menutup job `running` yang ditinggal mati — dan yang penting,
    // memberi tahu pemiliknya, bukan cuma mengubah baris di database.
    //
    // `busy` diteruskan karena hanya panggilan INI yang mengetahuinya, dan itu
    // satu-satunya cara membedakan export 25 sheet yang memang lama dari job yang
    // mati bersama Revit-nya. Tanpa itu penyapu hanya punya timer, dan timer
    // menutup job yang masih dikerjakan dengan alasan "Revit ditutup".
    // `caller` ikut diteruskan supaya penyapuan hanya menyentuh job PC INI.
    // Tanpa itu, satu /claim dari PC yang idle (`busy: false`) akan menutup job
    // PC lain yang justru sedang mengekspor — dengan alasan yang benar untuk
    // pemanggil dan keliru untuk pemilik job-nya.
    await sweepQuietly({
      caller: {
        machineId: caller.kind === 'row' ? caller.machine.id : null,
        addinBusy: body.busy === true,
      },
    });

    // `bot_enabled` GLOBAL — kill switch untuk semua PC sekaligus. `is_paused`
    // per-PC: /pause milik satu orang tidak boleh menghentikan Revit orang lain.
    // Dua sumber, dan itu memang dua hal yang berbeda.
    const state = await db.getMachine();
    const paused = caller.kind === 'row' ? caller.machine.is_paused : state.is_paused;

    if (paused || !state.bot_enabled) {
      return res.status(200).json({ job: null, paused: true });
    }

    // Add-in masih mengerjakan job sebelumnya di main thread Revit. Heartbeat
    // di atas sudah dicatat — itu justru tujuan panggilan ini — tapi memberi
    // job kedua akan membuat hasilnya saling menimpa.
    if (body.busy === true) {
      return res.status(200).json({ job: null, paused: false, busy: true });
    }

    const job = await db.claimNextCommand(caller.kind === 'row' ? caller.machine.id : null);
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

