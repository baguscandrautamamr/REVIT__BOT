/**
 * Akses Supabase lewat PostgREST, pakai `fetch` biasa.
 *
 * Tanpa SDK: yang dibutuhkan cuma select/insert/update sederhana, dan satu
 * dependensi runtime lebih sedikit berarti satu hal lebih sedikit yang bisa
 * rusak saat deploy. Semua request memakai service role key — jadi modul ini
 * TIDAK BOLEH diimpor oleh apa pun yang berjalan di browser.
 */
import { ENV } from './env';

export type Role = 'viewer' | 'admin';
export type LangPref = 'auto' | 'id' | 'en';
export type ThemePref = 'auto' | 'light' | 'dark';
export type Status = 'pending' | 'running' | 'done' | 'failed' | 'expired' | 'cancelled';

export interface BotUser {
  chat_id: number;
  name: string;
  role: Role;
  is_active: boolean;
  lang: LangPref;
  theme: ThemePref;
  created_at: string;
}

export interface CommandRow {
  id: string;
  chat_id: number;
  tg_message_id: number | null;
  command: string;
  payload: Record<string, unknown>;
  lang: 'id' | 'en';
  status: Status;
  doc_title: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface MachineState {
  id: number;
  last_seen_at: string | null;
  active_doc: string | null;
  revit_version: string | null;
  addin_version: string | null;
  is_paused: boolean;
  bot_enabled: boolean;
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ENV.supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ENV.supabaseKey,
      authorization: `Bearer ${ENV.supabaseKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** `Prefer: return=representation` supaya insert/update mengembalikan barisnya. */
const RETURNING = { prefer: 'return=representation' };

// ── bot_users ─────────────────────────────────────────────────────────────

export async function getUser(chatId: number): Promise<BotUser | null> {
  const rows = await rest<BotUser[]>(`bot_users?chat_id=eq.${chatId}&limit=1`);
  return rows[0] ?? null;
}

export async function listUsers(): Promise<BotUser[]> {
  return rest<BotUser[]>('bot_users?order=created_at.asc');
}

export async function updateUser(chatId: number, patch: Partial<BotUser>): Promise<void> {
  await rest(`bot_users?chat_id=eq.${chatId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ── machine_state ─────────────────────────────────────────────────────────

export async function getMachine(): Promise<MachineState> {
  const rows = await rest<MachineState[]>('machine_state?id=eq.1&limit=1');
  if (!rows[0]) throw new Error('machine_state kosong — jalankan migrasi 001_init.sql');
  return rows[0];
}

export async function updateMachine(patch: Partial<MachineState>): Promise<void> {
  await rest('machine_state?id=eq.1', { method: 'PATCH', body: JSON.stringify(patch) });
}

// ── commands ──────────────────────────────────────────────────────────────

export async function insertCommand(row: {
  chat_id: number;
  command: string;
  payload: Record<string, unknown>;
  lang: 'id' | 'en';
  tg_message_id?: number | null;
}): Promise<CommandRow> {
  const rows = await rest<CommandRow[]>('commands', {
    method: 'POST',
    headers: RETURNING,
    body: JSON.stringify([row]),
  });
  return rows[0];
}

export async function setCommandMessageId(id: string, messageId: number): Promise<void> {
  await rest(`commands?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ tg_message_id: messageId }),
  });
}

/**
 * Ambil satu job FIFO dan langsung tandai `running`.
 *
 * Filter `status=eq.pending` ikut disertakan pada PATCH, jadi kalau dua proses
 * memperebutkan baris yang sama, hanya satu yang mendapat baris kembali —
 * yang kalah mendapat array kosong. Cukup untuk satu PC Revit. Kalau nanti ada
 * PC kedua, ganti dengan fungsi Postgres `for update skip locked`.
 */
export async function claimNextCommand(): Promise<CommandRow | null> {
  const pending = await rest<CommandRow[]>(
    'commands?status=eq.pending&order=created_at.asc&limit=1',
  );
  const job = pending[0];
  if (!job) return null;

  const claimed = await rest<CommandRow[]>(
    `commands?id=eq.${job.id}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: RETURNING,
      body: JSON.stringify({ status: 'running', started_at: new Date().toISOString() }),
    },
  );
  return claimed[0] ?? null;
}

export async function finishCommand(
  id: string,
  patch: {
    status: Status;
    result?: Record<string, unknown> | null;
    error?: string | null;
    doc_title?: string | null;
  },
): Promise<CommandRow | null> {
  const rows = await rest<CommandRow[]>(`commands?id=eq.${id}`, {
    method: 'PATCH',
    headers: RETURNING,
    body: JSON.stringify({ ...patch, finished_at: new Date().toISOString() }),
  });
  return rows[0] ?? null;
}

export async function getCommand(id: string): Promise<CommandRow | null> {
  const rows = await rest<CommandRow[]>(`commands?id=eq.${id}&limit=1`);
  return rows[0] ?? null;
}

/** Cari command milik user berdasarkan awalan id — untuk `/cancel 3f9a`. */
export async function findPendingByPrefix(prefix: string): Promise<CommandRow | null> {
  const rows = await rest<CommandRow[]>(
    `commands?status=eq.pending&order=created_at.asc&limit=50`,
  );
  return rows.find((r) => r.id.startsWith(prefix.toLowerCase())) ?? null;
}

export async function cancelCommand(id: string): Promise<void> {
  await rest(`commands?id=eq.${id}&status=eq.pending`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled', finished_at: new Date().toISOString() }),
  });
}

/** Tandai kedaluwarsa semua yang lewat `expires_at`. Dipanggil dari claim. */
export async function expireStale(): Promise<void> {
  await rest(`commands?status=eq.pending&expires_at=lt.${new Date().toISOString()}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'expired', finished_at: new Date().toISOString() }),
  });
}

export async function queueSnapshot(): Promise<{
  pending: CommandRow[];
  running: CommandRow[];
  doneToday: number;
}> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const [pending, running, done] = await Promise.all([
    rest<CommandRow[]>('commands?status=eq.pending&order=created_at.asc&limit=20'),
    rest<CommandRow[]>('commands?status=eq.running&order=created_at.asc&limit=20'),
    rest<{ id: string }[]>(
      `commands?status=eq.done&finished_at=gte.${midnight.toISOString()}&select=id`,
    ),
  ]);
  return { pending, running, doneToday: done.length };
}

/** Command berat terakhir milik user — dasar perhitungan cooldown. */
export async function lastHeavyCommandAt(chatId: number, heavy: string[]): Promise<Date | null> {
  const list = heavy.map((h) => `"${h}"`).join(',');
  const rows = await rest<{ created_at: string }[]>(
    `commands?chat_id=eq.${chatId}&command=in.(${list})&order=created_at.desc&limit=1&select=created_at`,
  );
  return rows[0] ? new Date(rows[0].created_at) : null;
}
