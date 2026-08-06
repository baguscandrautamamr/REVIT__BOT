/**
 * GET /api/admin/diag?secret=… — diagnosa satu URL.
 *
 * Menjawab pertanyaan "kenapa bot diam" tanpa terminal dan tanpa menempelkan
 * token bot di address bar: token dibaca dari env di sisi server.
 *
 * Yang diperiksa, berurutan sesuai rantai:
 *   env → database → token bot → webhook → data (user, antrean, dedupe)
 *
 * Nilai rahasia tidak pernah ikut keluar — hanya panjang dan status cocok/tidak.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

import * as db from '../_lib/db';
import { ENV, WEBHOOK_SECRET_RULE, missingEnv, webhookSecretValid } from '../_lib/env';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const provided = String(req.query.secret ?? '');
  if (!ENV.webhookSecret || !timingSafeEqual(provided, ENV.webhookSecret)) {
    return res.status(403).json({
      error: 'forbidden',
      ...(webhookSecretValid() ? {} : { hint: WEBHOOK_SECRET_RULE }),
    });
  }

  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const expectedWebhook = `${proto}://${host}/api/telegram/webhook`;

  const out: Record<string, unknown> = {
    env: {
      missing: missingEnv(),
      panelUrl: ENV.panelUrl || null,
      webhookSecretFormat: webhookSecretValid() ? 'ok' : 'invalid',
    },
    expectedWebhook,
  };
  const problems: string[] = [];

  if (!webhookSecretValid()) problems.push(WEBHOOK_SECRET_RULE);

  // ── Database ───────────────────────────────────────────────────────────
  try {
    const machine = await db.getMachine();
    out.machineState = {
      exists: true,
      lastSeenAt: machine.last_seen_at,
      botEnabled: machine.bot_enabled,
      isPaused: machine.is_paused,
    };
    if (!machine.bot_enabled) problems.push('machine_state.bot_enabled = false — semua command ditolak');
  } catch (err) {
    out.machineState = { exists: false, error: short(err) };
    problems.push(
      'Baris machine_state tidak terbaca. Jalankan 001_init.sql, atau: ' +
        "insert into machine_state (id) values (1) on conflict do nothing;",
    );
  }

  try {
    const users = await db.listUsers();
    out.users = users.map((u) => ({
      chatId: u.chat_id,
      name: u.name,
      role: u.role,
      isActive: u.is_active,
      lang: u.lang,
    }));
    if (users.length === 0) problems.push('Tabel bot_users kosong — semua orang dijawab "belum terdaftar"');
    if (users.some((u) => u.chat_id === 123456789)) {
      problems.push(
        'Ada baris dengan chat_id 123456789 — itu angka contoh dari dokumentasi, ' +
          'bukan chat ID sungguhan. Hapus: delete from bot_users where chat_id = 123456789;',
      );
    }
  } catch (err) {
    out.users = { error: short(err) };
    problems.push('bot_users tidak terbaca — cek SUPABASE_SERVICE_ROLE_KEY (harus service_role, bukan anon)');
  }

  try {
    const queue = await db.queueSnapshot();
    out.queue = {
      pending: queue.pending.length,
      running: queue.running.length,
      doneToday: queue.doneToday,
    };
  } catch (err) {
    out.queue = { error: short(err) };
  }

  // ── Telegram ───────────────────────────────────────────────────────────
  if (!ENV.botToken) {
    problems.push('TELEGRAM_BOT_TOKEN kosong');
  } else {
    try {
      const me = await tg('getMe');
      out.bot = { username: me.username, id: me.id };
    } catch (err) {
      out.bot = { error: short(err) };
      problems.push('getMe gagal — token bot salah atau sudah di-revoke');
    }

    try {
      const info = await tg('getWebhookInfo');
      out.webhook = {
        url: info.url || null,
        pendingUpdateCount: info.pending_update_count,
        lastErrorDate: info.last_error_date
          ? new Date(info.last_error_date * 1000).toISOString()
          : null,
        lastErrorMessage: info.last_error_message ?? null,
        hasCustomCertificate: info.has_custom_certificate,
        maxConnections: info.max_connections,
        allowedUpdates: info.allowed_updates ?? null,
      };

      if (!info.url) {
        problems.push(
          'Webhook BELUM dipasang. Buka /api/admin/setup?secret=… sekali untuk memasangnya.',
        );
      } else if (info.url !== expectedWebhook) {
        problems.push(
          `Webhook menunjuk ke ${info.url}, bukan ke ${expectedWebhook}. ` +
            'Buka /api/admin/setup?secret=… dari domain yang benar.',
        );
      }
      if (info.last_error_message) {
        problems.push(`Telegram melaporkan error terakhir: ${info.last_error_message}`);
      }
      if ((info.pending_update_count ?? 0) > 5) {
        problems.push(
          `${info.pending_update_count} update menumpuk — handler gagal atau lambat menjawab.`,
        );
      }
    } catch (err) {
      out.webhook = { error: short(err) };
    }
  }

  // ── Uji jalur webhook secara langsung ──────────────────────────────────
  //
  // Ini yang membedakan "Telegram tidak mengirim" dari "handler menolak".
  // Kita POST update kosong ke webhook kita sendiri, dengan header rahasia
  // yang persis dipakai Telegram. Body tanpa `message`/`callback_query`
  // membuat handler tidak melakukan apa-apa — jadi aman diulang.
  try {
    const probe = await fetch(expectedWebhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': ENV.webhookSecret,
      },
      body: JSON.stringify({ update_id: 0 }),
    });
    const body = (await probe.text()).slice(0, 200);
    out.webhookSelfTest = { status: probe.status, body };

    if (probe.status === 403) {
      problems.push(
        'Handler webhook menolak header rahasianya sendiri (403). Artinya nilai ' +
          'TELEGRAM_WEBHOOK_SECRET yang dipakai saat setWebhook BERBEDA dengan yang ' +
          'ada di environment variable Vercel. Penyebab paling sering: env sudah ' +
          'diubah tapi deployment belum di-Redeploy, jadi fungsi masih memakai nilai lama.',
      );
    } else if (probe.status === 404) {
      problems.push(
        `${expectedWebhook} menjawab 404 — fungsi webhook tidak ada di deployment ini. ` +
          'Pastikan deployment produksi memakai commit terbaru.',
      );
    } else if (probe.status !== 200) {
      problems.push(`Webhook menjawab HTTP ${probe.status}. Telegram menganggap non-2xx sebagai gagal.`);
    }
  } catch (err) {
    out.webhookSelfTest = { error: short(err) };
    problems.push('Tidak bisa menghubungi webhook sendiri — cek log fungsi di Vercel.');
  }

  // ── Dedupe ─────────────────────────────────────────────────────────────
  try {
    const res2 = await fetch(`${ENV.supabaseUrl}/rest/v1/tg_updates?select=update_id&limit=1`, {
      headers: { apikey: ENV.supabaseKey, authorization: `Bearer ${ENV.supabaseKey}` },
    });
    out.tgUpdatesTable = res2.ok ? 'ok' : `HTTP ${res2.status}`;
    if (!res2.ok) problems.push('Tabel tg_updates belum ada — jalankan 002_security.sql');
  } catch (err) {
    out.tgUpdatesTable = short(err);
  }

  out.problems = problems;
  out.verdict = problems.length === 0 ? 'Semua terlihat benar.' : `${problems.length} masalah ditemukan.`;

  res.setHeader('cache-control', 'no-store');
  return res.status(200).json(out);
}

async function tg(method: string): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${ENV.botToken}/${method}`);
  const json = (await res.json()) as { ok: boolean; result?: any; description?: string };
  if (!json.ok) throw new Error(json.description ?? `${method} gagal`);
  return json.result;
}

function short(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown';
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
