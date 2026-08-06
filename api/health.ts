/**
 * GET /api/health — cek kesiapan deployment tanpa membocorkan rahasia.
 *
 * Melaporkan NAMA env yang kosong dan apakah Supabase bisa dihubungi.
 * Buka di browser setelah deploy pertama: itu cara tercepat tahu apakah
 * masalahnya ada di env, di database, atau di Telegram.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from './_lib/db';
import { WEBHOOK_SECRET_RULE, missingEnv, webhookSecretValid } from './_lib/env';
import { bucketReady } from './_lib/storage';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const missing = missingEnv();
  const secretOk = webhookSecretValid();

  let database: 'ok' | 'error' | 'skipped' = 'skipped';
  let detail: string | null = null;
  let storage: 'ok' | 'missing' | 'skipped' = 'skipped';
  let storageDetail: string | null = null;

  if (!missing.includes('SUPABASE_URL') && !missing.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      await db.getMachine();
      database = 'ok';
    } catch (err) {
      database = 'error';
      detail = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
    }

    // Bucket berkas diperiksa terpisah dari tabel: ia dibuat oleh migrasi yang
    // berbeda (003), dan tanpa itu SEMUA export di atas 3 MB gagal — sementara
    // seluruh bagian lain bot terlihat sehat sempurna.
    const bucket = await bucketReady();
    storage = bucket.ok ? 'ok' : 'missing';
    storageDetail = bucket.detail;
  }

  const ready = missing.length === 0 && database === 'ok' && secretOk && storage === 'ok';
  res.setHeader('cache-control', 'no-store');
  return res.status(ready ? 200 : 503).json({
    ready,
    missingEnv: missing,   // hanya nama, tidak pernah nilainya
    // Hanya melaporkan VALID/TIDAK, bukan isinya. Format yang salah adalah
    // penyebab "bot diam" yang paling sulit ditebak, jadi ia disebut di sini
    // — halaman pertama yang orang buka.
    webhookSecretFormat: secretOk ? 'ok' : 'invalid',
    ...(secretOk ? {} : { webhookSecretRule: WEBHOOK_SECRET_RULE }),
    database,
    detail,
    // Bucket persinggahan berkas export. "missing" berarti /pdf akan selesai
    // di Revit lalu berkasnya tidak pernah sampai — jalankan migrasi 003.
    storage,
    storageDetail,
    time: new Date().toISOString(),
  });
}
