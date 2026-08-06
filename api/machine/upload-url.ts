/**
 * POST /api/machine/upload-url — minta tempat unggah untuk hasil satu job.
 *
 * Body:  { id: "<job uuid>", name: "PRJ_LP-01_2026-08-06.pdf" }
 * Balas: { uploadUrl: "https://…/object/upload/sign/job-files/…?token=…",
 *          path: "<job-id>.pdf" }
 *
 * Add-in mengunggah berkasnya LANGSUNG ke `uploadUrl` — tidak lewat Vercel —
 * lalu menyebut `path` di /api/machine/report. Ini satu-satunya cara berkas
 * berukuran nyata bisa sampai: body request ke Serverless Function dibatasi
 * 4,5 MB oleh platform Vercel, batas keras yang tidak bisa dinaikkan lewat
 * konfigurasi apa pun. Lihat supabase/migrations/003_storage.sql.
 *
 * Yang dikembalikan hanya izin menulis ke SATU path untuk waktu singkat.
 * Service role key tidak pernah meninggalkan server.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from '../_lib/db';
import { authorized } from '../_lib/machineauth';
import { createUploadUrl, objectPath } from '../_lib/storage';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as {
    id?: string;
    name?: string;
  };

  if (!body.id) return res.status(400).json({ error: 'id required' });

  try {
    // Path diikat ke job yang benar-benar ada dan benar-benar sedang berjalan.
    // Tanpa pemeriksaan ini, siapa pun yang memegang machine token bisa
    // menulis objek sebanyak-banyaknya ke bucket dengan id karangan.
    const job = await db.getCommand(body.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status !== 'running') {
      return res.status(409).json({ error: 'not running', status: job.status });
    }

    const path = objectPath(job.id, body.name ?? 'hasil.bin');
    const { uploadUrl } = await createUploadUrl(path).then((r) => ({ uploadUrl: r.url }));

    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({ uploadUrl, path });
  } catch (err) {
    console.error('[upload-url]', err);
    return res.status(500).json({
      error: 'internal',
      detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
  }
}
