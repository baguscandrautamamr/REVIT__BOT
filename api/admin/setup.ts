/**
 * GET /api/admin/setup?secret=… — pasang seluruh konfigurasi Telegram dari
 * browser, tanpa terminal.
 *
 * Sekali buka, endpoint ini mengerjakan: setWebhook, menu command dua bahasa,
 * menu penuh untuk tiap admin di tabel `bot_users`, deskripsi profil, dan
 * tombol Mini App. Aman dijalankan berkali-kali — semuanya menimpa, bukan
 * menambah.
 *
 * Otorisasi memakai TELEGRAM_WEBHOOK_SECRET. Tanpa itu, siapa pun yang menebak
 * URL-nya bisa memindahkan webhook botmu ke server lain.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

import { applyBotSetup } from '../_lib/botsetup';
import * as db from '../_lib/db';
import { ENV, WEBHOOK_SECRET_RULE, missingEnv, webhookSecretValid } from '../_lib/env';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = String(req.query.secret ?? '');
  if (!ENV.webhookSecret || !timingSafeEqual(provided, ENV.webhookSecret)) {
    // Pesannya tidak membedakan "secret salah" dan "secret kosong" — itu
    // informasi untuk penebak. Tapi format secret yang TERSIMPAN memang
    // dilaporkan: itu soal konfigurasi server, bukan nilainya, dan tanpa
    // petunjuk ini 403-nya buntu (`+` di URL terbaca sebagai spasi, jadi
    // secret yang benar pun tidak akan pernah cocok).
    return res.status(403).json({
      error: 'forbidden',
      ...(webhookSecretValid() ? {} : { hint: WEBHOOK_SECRET_RULE }),
    });
  }

  const missing = missingEnv();
  if (missing.includes('TELEGRAM_BOT_TOKEN')) {
    return res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN belum diisi' });
  }

  // Asal server diambil dari request, bukan dari env — jadi endpoint ini
  // selalu memasang webhook ke domain tempat ia sendiri berjalan.
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const baseUrl = `${proto}://${host}`;

  try {
    let adminChatIds: number[] = [];
    try {
      const users = await db.listUsers();
      adminChatIds = users.filter((u) => u.role === 'admin' && u.is_active).map((u) => u.chat_id);
    } catch (err) {
      console.error('[setup] gagal membaca bot_users', err);
    }

    const report = await applyBotSetup({
      botToken: ENV.botToken,
      baseUrl,
      adminChatIds,
      webhookSecret: ENV.webhookSecret,
      panelUrl: ENV.panelUrl || undefined,
    });

    res.setHeader('cache-control', 'no-store');
    return res.status(200).json({ ok: true, baseUrl, ...report });
  } catch (err) {
    console.error('[setup]', err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'internal',
    });
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
