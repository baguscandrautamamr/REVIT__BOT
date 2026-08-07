/**
 * /api/panel/machines — daftarkan PC Revit dari panel, tanpa menyentuh Vercel.
 *
 *   GET                   daftar PC + apakah migrasi 005 sudah jalan
 *   POST   {name}         buat token, simpan hash-nya, kembalikan token MENTAH sekali
 *   DELETE ?id=…          cabut izin PC (bukan hapus — lihat db.setMachineActive)
 *
 * Ada supaya menambah PC tidak lagi berarti menambah environment variable di
 * Vercel lalu men-deploy ulang. Alasan lengkapnya di supabase/migrations/005.
 *
 * Otorisasi sama dengan panel/users: `x-telegram-init-data` diverifikasi HMAC,
 * lalu peran dibaca dari database — BUKAN dari apa pun yang dikirim klien.
 *
 * ── Token hanya ditampilkan SEKALI ─────────────────────────────────────────
 * Yang tersimpan cuma SHA-256-nya, jadi tidak ada jalan mengembalikannya. Itu
 * pilihan yang disengaja: database yang bocor tidak boleh berisi kunci yang
 * langsung bisa dipakai. Konsekuensinya harus sampai ke admin di layar, bukan
 * hanya tertulis di dokumen — token yang hilang DIGANTI, bukan dipulihkan.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

import * as db from '../_lib/db';
import { ENV } from '../_lib/env';
import { tokenHash } from '../_lib/machineauth';
import { verifyInitData } from '../_lib/telegram';

const NAME_MAX = 64;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = req.headers['x-telegram-init-data'];
  const initData = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  const auth = verifyInitData(initData);
  if (!auth.ok) return res.status(401).json({ error: 'unauthorized', reason: auth.reason });

  res.setHeader('cache-control', 'no-store');

  try {
    const me = await db.getUser(auth.user.id);
    if (!me || !me.is_active) return res.status(403).json({ error: 'not_registered' });
    if (me.role !== 'admin') return res.status(403).json({ error: 'not_admin' });

    switch (req.method) {
      case 'GET':
        return res.status(200).json({
          machines: (await db.listMachines()).map(slim),
          // Panel harus bisa MENGATAKAN kenapa tombolnya mati, bukan cuma
          // mematikannya. Langkah SQL yang terlewat di repo ini pernah muncul
          // sebagai berkas yang tidak pernah sampai, bukan sebagai pesan.
          ready: await db.machinesReady(),
          // Migrasi 007 — penanda "boleh dilihat user lain". Dilaporkan terpisah
          // supaya panel bisa mematikan tombolnya dengan KALIMAT, bukan diam.
          sharingReady: await db.sharingReady(),
          // PC yang masih memakai MACHINE_TOKEN dari environment tidak punya
          // baris di sini, jadi daftar yang kosong bukan berarti tidak ada PC.
          envFallback: Boolean(ENV.machineToken),
        });
      case 'POST':
        return await add(req, res);
      case 'PATCH':
        return await share(req, res);
      case 'DELETE':
        return await revoke(req, res);
      default:
        return res.status(405).json({ error: 'method' });
    }
  } catch (err) {
    console.error('[panel/machines]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

async function add(req: VercelRequest, res: VercelResponse) {
  if (!(await db.machinesReady())) return res.status(409).json({ error: 'needs_migration' });

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as {
    name?: unknown;
  };

  const name = String(body.name ?? '').trim().slice(0, NAME_MAX);
  if (!name) return res.status(400).json({ error: 'bad_name' });

  // Dibuat SERVER, bukan diminta dari admin. Entropinya sama dengan
  // `openssl rand -hex 32`, dan admin tidak perlu membuka terminal sama sekali —
  // yang selama ini justru penghalang menambah PC kedua.
  const token = crypto.randomBytes(32).toString('hex');
  const machine = await db.createMachine(name, tokenHash(token));

  // `token` ADA DI BALASAN INI DAN TIDAK DI MANA-MANA LAGI.
  return res.status(200).json({ ok: true, machine: slim(machine), token });
}

/**
 * Buka/tutup PC dari daftar `/active` orang lain.
 *
 * HANYA soal melihat. Ia tidak memberi siapa pun kemampuan mengirim perintah ke
 * PC itu — job tetap diarahkan `bot_users.machine_id`, dan hanya admin yang bisa
 * mengubahnya. Pembedaan itu yang membuat tombol ini murah: membuka daftar tidak
 * bisa membekukan Revit siapa pun.
 */
async function share(req: VercelRequest, res: VercelResponse) {
  if (!(await db.sharingReady())) return res.status(409).json({ error: 'needs_sharing_migration' });

  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'bad_id' });

  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as {
    shared?: unknown;
  };

  const machine = await db.setMachineShared(id, body.shared === true);
  if (!machine) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ ok: true, machine: slim(machine) });
}

async function revoke(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'bad_id' });

  const machine = await db.setMachineActive(id, false);
  if (!machine) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ ok: true, machine: slim(machine) });
}

function slim(m: db.Machine) {
  return {
    id: m.id,
    name: m.name,
    isActive: m.is_active,
    lastSeenAt: m.last_seen_at,
    activeDoc: m.active_doc,
    revitVersion: m.revit_version,
    addinVersion: m.addin_version,
    shared: m.shared === true,
  };
}
