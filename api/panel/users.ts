/**
 * /api/panel/users — kelola siapa yang boleh memakai bot, dari panel.
 *
 *   GET                    daftar user
 *   POST   {chatId,name,role}   tambah, atau kembalikan akses yang dicabut
 *   DELETE ?chatId=…       cabut akses (bukan hapus — lihat db.setUserActive)
 *
 * Sebelum ada berkas ini satu-satunya cara menambah user adalah menulis SQL di
 * Supabase. Itu masuk akal untuk admin PERTAMA — jadi admin memang harus punya
 * akses database, dan tidak ada yang bisa mendaftarkan dirinya sendiri lewat
 * chat. Tapi untuk orang kedua dan seterusnya itu memaksa pemilik bot membuka
 * konsol database hanya untuk menyalin satu angka.
 *
 * Otorisasi sama dengan panel/state: `x-telegram-init-data` diverifikasi HMAC,
 * lalu perannya dibaca dari database — BUKAN dari apa pun yang dikirim klien.
 * Konsekuensinya endpoint ini hanya bisa dipakai dari dalam Telegram, dan itu
 * disengaja: satu-satunya alternatif adalah menaruh secret di URL, dan secret
 * yang sama juga mengendalikan webhook.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

import * as db from '../_lib/db';
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
        return res.status(200).json({ users: (await db.listUsers()).map(slim) });
      case 'POST':
        return await add(req, res);
      case 'DELETE':
        return await revoke(req, res, me.chat_id);
      default:
        return res.status(405).json({ error: 'method' });
    }
  } catch (err) {
    console.error('[panel/users]', err);
    return res.status(500).json({ error: 'internal' });
  }
}

async function add(req: VercelRequest, res: VercelResponse) {
  const body = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})) as {
    chatId?: unknown;
    name?: unknown;
    role?: unknown;
    machineId?: unknown;
  };

  // Chat ID Telegram bisa lebih besar dari 2^32, jadi rentangnya diperiksa
  // sebagai safe integer — bukan parseInt lalu berharap.
  const chatId = Number(body.chatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return res.status(400).json({ error: 'bad_chat_id' });
  }

  const name = String(body.name ?? '').trim().slice(0, NAME_MAX);
  if (!name) return res.status(400).json({ error: 'bad_name' });

  // Apa pun selain 'admin' jatuh ke 'viewer'. Peran yang tidak dikenal tidak
  // boleh berakhir sebagai peran yang lebih besar dari yang dimaksud.
  const role = body.role === 'admin' ? 'admin' : 'viewer';

  const user = await db.upsertUser({ chat_id: chatId, name, role });

  // Penugasan PC ditulis TERPISAH, bukan lewat upsert di atas, dan itu bukan
  // kemalasan: `upsertUser` dipakai juga untuk menghidupkan kembali user yang
  // pernah dicabut, dan yang ditimpanya hanya kolom yang ikut dikirim. Menyelipkan
  // `machine_id` ke sana berarti membuka ulang akses seseorang otomatis
  // MENGHAPUS penugasan PC-nya — hilangnya tidak terlihat sampai orang itu
  // mengirim perintah dan dijawab "belum dipasangkan".
  if (await db.routingReady()) {
    const raw = body.machineId;
    const machineId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;

    // Id karangan tidak boleh tersimpan: `targetFor` akan mengabaikan penugasan
    // yang tidak menunjuk PC mana pun, lalu user itu dijawab "belum dipasangkan"
    // padahal panel menampilkannya sebagai sudah dipasangkan.
    if (machineId !== null && !(await db.listMachines()).some((m) => m.id === machineId)) {
      return res.status(400).json({ error: 'bad_machine' });
    }

    await db.updateUser(chatId, { machine_id: machineId });
    return res.status(200).json({ ok: true, user: slim({ ...user, machine_id: machineId }) });
  }

  return res.status(200).json({ ok: true, user: slim(user) });
}

async function revoke(req: VercelRequest, res: VercelResponse, meChatId: number) {
  const chatId = Number(req.query.chatId);
  if (!Number.isSafeInteger(chatId)) return res.status(400).json({ error: 'bad_chat_id' });

  // Mencabut akses diri sendiri akan mengunci admin terakhir di luar panel, dan
  // memulihkannya butuh SQL Editor lagi — persis yang ingin dihindari.
  if (chatId === meChatId) return res.status(400).json({ error: 'self' });

  const user = await db.setUserActive(chatId, false);
  if (!user) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ ok: true, user: slim(user) });
}

function slim(u: db.BotUser) {
  return {
    chatId: u.chat_id,
    name: u.name,
    role: u.role,
    isActive: u.is_active,
    machineId: u.machine_id ?? null,
  };
}
