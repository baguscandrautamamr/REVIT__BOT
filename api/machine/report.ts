/**
 * POST /api/machine/report — add-in melapor hasil satu job.
 *
 * Body:
 * {
 *   "id": "uuid",
 *   "ok": true,
 *   "docTitle": "PRJ-B.rvt",
 *   "text": "Lampu 184\n…",                    // opsional
 *   "error": "…",                              // saat ok=false
 *   "file": { "name": "…pdf", "base64": "…" }  // opsional, ≤ 50 MB
 * }
 *
 * Hasilnya meng-EDIT pesan "⏳" yang sudah ada, bukan mengirim pesan baru.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

import * as db from '../_lib/db';
import { ENV } from '../_lib/env';
import { translator } from '../_lib/i18n';
import { resultText } from '../_lib/reply';
import { editMessageText, mdv2, sendDocument, sendMessage } from '../_lib/telegram';

/** Batas upload bot Telegram. Di atas ini harus lewat Storage + signed URL. */
const MAX_UPLOAD = 50 * 1024 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const body = (req.body ?? {}) as {
    id?: string;
    ok?: boolean;
    docTitle?: string | null;
    text?: string;
    error?: string;
    file?: { name: string; base64: string };
  };

  if (!body.id) return res.status(400).json({ error: 'id required' });

  try {
    const job = await db.getCommand(body.id);
    if (!job) return res.status(404).json({ error: 'not found' });

    const ok = body.ok !== false;
    const updated = await db.finishCommand(job.id, {
      status: ok ? 'done' : 'failed',
      result: ok ? { ok: true, text: body.text ?? '' } : null,
      error: ok ? null : (body.error ?? 'unknown'),
      doc_title: body.docTitle ?? null,
    });

    const locale = job.lang;
    const t = translator(locale);
    const head = ok ? t('common.done') : t('errors.revitError', { message: body.error ?? '—' });
    const detail = ok ? resultText(updated?.result ?? { text: body.text ?? '' }) : '';
    const message = `${mdv2(head)}${detail ? '\n' + detail : ''}`;

    // Edit pesan "⏳". Kalau message_id hilang (mis. user hapus pesannya),
    // kirim baru — jangan sampai hasil kerja Revit menguap.
    if (job.tg_message_id) {
      try {
        await editMessageText(job.chat_id, job.tg_message_id, message);
      } catch {
        await sendMessage(job.chat_id, message);
      }
    } else {
      await sendMessage(job.chat_id, message);
    }

    if (ok && body.file?.base64) {
      const bytes = Buffer.from(body.file.base64, 'base64');
      if (bytes.byteLength > MAX_UPLOAD) {
        await sendMessage(
          job.chat_id,
          mdv2(
            t('errors.fileTooBig', {
              size: (bytes.byteLength / 1024 / 1024).toFixed(1),
              url: '—',
            }),
          ),
        );
      } else {
        await sendDocument(job.chat_id, { name: body.file.name, bytes });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[report]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

function authorized(req: VercelRequest): boolean {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !ENV.machineToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(ENV.machineToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** File PDF besar dikirim sebagai base64 — naikkan batas body dari 1 MB. */
export const config = { api: { bodyParser: { sizeLimit: '70mb' } } };
