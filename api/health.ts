/**
 * GET /api/health — cek kesiapan deployment tanpa membocorkan rahasia.
 *
 * Melaporkan NAMA env yang kosong dan apakah Supabase bisa dihubungi.
 * Buka di browser setelah deploy pertama: itu cara tercepat tahu apakah
 * masalahnya ada di env, di database, atau di Telegram.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from './_lib/db';
import { missingEnv } from './_lib/env';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const missing = missingEnv();

  let database: 'ok' | 'error' | 'skipped' = 'skipped';
  let detail: string | null = null;

  if (!missing.includes('SUPABASE_URL') && !missing.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      await db.getMachine();
      database = 'ok';
    } catch (err) {
      database = 'error';
      detail = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
    }
  }

  const ready = missing.length === 0 && database === 'ok';
  res.setHeader('cache-control', 'no-store');
  return res.status(ready ? 200 : 503).json({
    ready,
    missingEnv: missing,   // hanya nama, tidak pernah nilainya
    database,
    detail,
    time: new Date().toISOString(),
  });
}
