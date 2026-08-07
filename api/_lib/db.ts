/**
 * Akses Supabase lewat PostgREST, pakai `fetch` biasa.
 *
 * Tanpa SDK: yang dibutuhkan cuma select/insert/update sederhana, dan satu
 * dependensi runtime lebih sedikit berarti satu hal lebih sedikit yang bisa
 * rusak saat deploy. Semua request memakai service role key — jadi modul ini
 * TIDAK BOLEH diimpor oleh apa pun yang berjalan di browser.
 */
import { ENV } from './env';
import { startOfLocalDay } from './limits';

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
  /**
   * Judul project pilihan user; null = ikut dokumen aktif di Revit.
   * Ada hanya setelah migrasi 004 — lihat `projectSelectionReady`.
   */
  project?: string | null;
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
  /** Ada hanya setelah migrasi 004 dijalankan — lihat `projectSelectionReady`. */
  open_docs?: string[] | null;
}

/**
 * Migrasi 004 (pilihan project per user) sudah dijalankan atau belum.
 *
 * Diperiksa, bukan diasumsikan. Kolom yang belum ada membuat PostgREST menolak
 * SELURUH request — bukan cuma bagian yang menyentuhnya — jadi tanpa
 * pemeriksaan ini satu langkah SQL yang terlewat mematikan `/claim`, dan
 * bersamanya seluruh bot. Repo ini sudah pernah kehilangan `003_storage.sql`
 * dengan cara yang sama.
 *
 * Hasilnya di-cache: kolomnya tidak akan muncul dan hilang di tengah jalan, dan
 * memeriksanya tiap 4 detik hanya menambah satu request ke setiap heartbeat.
 */
let projectColumns: boolean | null = null;

export async function projectSelectionReady(): Promise<boolean> {
  if (projectColumns !== null) return projectColumns;
  try {
    await rest('machine_state?id=eq.1&limit=1&select=open_docs');
    await rest('bot_users?limit=1&select=project');
    projectColumns = true;
  } catch {
    console.warn('[db] migrasi 004 belum dijalankan — pilihan project dimatikan');
    projectColumns = false;
  }
  return projectColumns;
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

/**
 * Tambah user — atau hidupkan lagi yang pernah dicabut aksesnya.
 *
 * `resolution=merge-duplicates` membuat chat_id yang sudah ada di-UPDATE, bukan
 * ditolak 409. Yang ditimpa hanya kolom yang ikut dikirim, jadi `lang`, `theme`,
 * dan `created_at` milik user lama tetap utuh: mencabut lalu memberi akses lagi
 * tidak menghapus preferensinya.
 */
export async function upsertUser(row: {
  chat_id: number;
  name: string;
  role: Role;
}): Promise<BotUser> {
  const rows = await rest<BotUser[]>('bot_users', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ ...row, is_active: true }]),
  });
  return rows[0]!;
}

/**
 * Cabut/kembalikan akses. Sengaja BUKAN DELETE: `commands.chat_id` menunjuk ke
 * baris ini, jadi menghapusnya akan ditolak foreign key begitu user itu pernah
 * memakai bot — dan riwayat siapa menjalankan apa ikut hilang.
 *
 * Mengembalikan null kalau chat_id-nya tidak ada.
 */
export async function setUserActive(chatId: number, active: boolean): Promise<BotUser | null> {
  const rows = await rest<BotUser[]>(`bot_users?chat_id=eq.${chatId}`, {
    method: 'PATCH',
    headers: RETURNING,
    body: JSON.stringify({ is_active: active }),
  });
  return rows[0] ?? null;
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

// ── machines ──────────────────────────────────────────────────────────────

/**
 * Satu PC Revit. `token_hash` SENGAJA tidak ada di tipe ini: seluruh pembacaan
 * memakai daftar kolom eksplisit di bawah, jadi hash-nya tidak pernah ikut
 * keluar dari modul ini — apalagi sampai ke panel.
 */
export interface Machine {
  id: string;
  name: string;
  is_active: boolean;
  last_seen_at: string | null;
  active_doc: string | null;
  open_docs: string[] | null;
  revit_version: string | null;
  addin_version: string | null;
  is_paused: boolean;
  created_at: string;
}

const MACHINE_FIELDS =
  'id,name,is_active,last_seen_at,active_doc,open_docs,revit_version,addin_version,is_paused,created_at';

/**
 * Migrasi 005 (tabel `machines`) sudah dijalankan atau belum.
 *
 * Diperiksa dengan alasan yang persis sama seperti `projectSelectionReady`, tapi
 * di jalur yang jauh lebih berbahaya: pencarian token dipanggil di SETIAP
 * /api/machine/claim. Tabel yang belum ada membuat PostgREST menjawab error, dan
 * kalau error itu dibiarkan naik, seluruh autentikasi mesin gagal — bukan cuma
 * fitur barunya. Bot yang tadinya sehat mati karena satu langkah SQL yang
 * memang OPSIONAL.
 */
let machinesTable: boolean | null = null;

export async function machinesReady(): Promise<boolean> {
  if (machinesTable !== null) return machinesTable;
  try {
    await rest(`machines?limit=1&select=id`);
    machinesTable = true;
  } catch {
    console.warn('[db] migrasi 005 belum dijalankan — daftar PC dimatikan, memakai MACHINE_TOKEN');
    machinesTable = false;
  }
  return machinesTable;
}

export async function listMachines(): Promise<Machine[]> {
  if (!(await machinesReady())) return [];
  return rest<Machine[]>(`machines?select=${MACHINE_FIELDS}&order=created_at.asc`);
}

/**
 * Cari PC dari hash token-nya. Mengembalikan null — tidak melempar — kalau
 * tabelnya belum ada, supaya jalur `MACHINE_TOKEN` lama tetap bisa dicoba.
 */
export async function findMachineByTokenHash(hash: string): Promise<Machine | null> {
  if (!(await machinesReady())) return null;
  const rows = await rest<Machine[]>(
    `machines?token_hash=eq.${encodeURIComponent(hash)}&limit=1&select=${MACHINE_FIELDS}`,
  );
  return rows[0] ?? null;
}

export async function createMachine(name: string, tokenHash: string): Promise<Machine> {
  const rows = await rest<Machine[]>(`machines?select=${MACHINE_FIELDS}`, {
    method: 'POST',
    headers: RETURNING,
    body: JSON.stringify([{ name, token_hash: tokenHash }]),
  });
  return rows[0]!;
}

/**
 * Cabut/kembalikan izin satu PC. Sengaja BUKAN DELETE, alasan yang sama seperti
 * `setUserActive`: barisnya adalah catatan PC mana yang pernah ada, dan
 * menghapusnya membuat token yang sama bisa didaftarkan lagi tanpa jejak.
 */
export async function setMachineActive(id: string, active: boolean): Promise<Machine | null> {
  const rows = await rest<Machine[]>(`machines?id=eq.${id}&select=${MACHINE_FIELDS}`, {
    method: 'PATCH',
    headers: RETURNING,
    body: JSON.stringify({ is_active: active }),
  });
  return rows[0] ?? null;
}

/**
 * Catat heartbeat satu PC.
 *
 * Tidak pernah melempar: heartbeat per-PC hanyalah yang membuat panel jujur
 * tentang PC mana yang hidup. Heartbeat yang BENAR-BENAR menentukan — `/status`,
 * `/project`, penyapu — masih di `machine_state`, dan menjatuhkan /claim karena
 * catatan tambahan ini gagal berarti bot mati demi baris kosmetik.
 */
export async function touchMachine(id: string, patch: Partial<Machine>): Promise<void> {
  try {
    await rest(`machines?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  } catch (err) {
    console.error('[db] touchMachine', err);
  }
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

/**
 * Tutup job yang sedang berjalan.
 *
 * Filter `status=eq.running` ikut disertakan pada PATCH — sama seperti
 * `claimNextCommand` dan `cancelCommand` — jadi hanya laporan PERTAMA yang
 * mendapat barisnya kembali. Mengembalikan null berarti job itu sudah ditutup
 * lebih dulu: add-in mengirim laporan dua kali, atau penyapu sudah menandainya
 * "stuck". Tanpa filter ini laporan ganda mengedit pesan user dua kali dan
 * mengirim ulang file PDF yang sama.
 */
export async function finishCommand(
  id: string,
  patch: {
    status: Status;
    result?: Record<string, unknown> | null;
    error?: string | null;
    doc_title?: string | null;
  },
): Promise<CommandRow | null> {
  const rows = await rest<CommandRow[]>(`commands?id=eq.${id}&status=eq.running`, {
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

/** Mengembalikan baris yang benar-benar dibatalkan — null kalau sudah telanjur jalan. */
export async function cancelCommand(id: string): Promise<CommandRow | null> {
  const rows = await rest<CommandRow[]>(`commands?id=eq.${id}&status=eq.pending`, {
    method: 'PATCH',
    headers: RETURNING,
    body: JSON.stringify({ status: 'cancelled', finished_at: new Date().toISOString() }),
  });
  return rows[0] ?? null;
}

/**
 * Tandai kedaluwarsa semua yang lewat `expires_at`.
 *
 * Mengembalikan barisnya, bukan void: pemanggil WAJIB memberi tahu pemiliknya.
 * Tanpa itu pesan "⏳" di chat tidak pernah berubah, dan menunggu selamanya
 * tidak bisa dibedakan dari bot yang rusak.
 */
export async function expireStale(): Promise<CommandRow[]> {
  return rest<CommandRow[]>(
    `commands?status=eq.pending&expires_at=lt.${new Date().toISOString()}`,
    {
      method: 'PATCH',
      headers: RETURNING,
      body: JSON.stringify({ status: 'expired', finished_at: new Date().toISOString() }),
    },
  );
}

/**
 * Tandai gagal semua job `running` yang lebih tua dari `olderThanMs`.
 *
 * BATASNYA DITENTUKAN PEMANGGIL, dan itu bukan detail: satu angka tidak bisa
 * membedakan export 25 sheet yang memang lama dari job yang mati bersama
 * Revit-nya. `sweep.ts` memilih angkanya berdasarkan apa yang dilaporkan add-in
 * — lihat catatan di sana.
 *
 * `expireStale` tidak menyentuh ini: ia hanya melihat `pending`. Tanpa penyapu
 * kedua, satu crash Revit meninggalkan baris `running` selamanya — pesan "⏳"
 * milik user tidak pernah selesai, dan /status melaporkan "1 jalan" terus.
 */
export async function reapRunning(olderThanMs: number, reason: string): Promise<CommandRow[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return rest<CommandRow[]>(
    `commands?status=eq.running&started_at=lt.${cutoff}`,
    {
      method: 'PATCH',
      headers: RETURNING,
      body: JSON.stringify({
        status: 'failed',
        error: `stuck: ${reason}`,
        finished_at: new Date().toISOString(),
      }),
    },
  );
}

/**
 * Tutup job yang SUDAH ditandai penyapu, karena laporannya ternyata datang juga.
 *
 * Ada karena tebakan penyapu bisa salah, dan kalau salah harganya mahal: Revit
 * sudah selesai mengekspor 25 sheet — belasan menit kerja — dan satu-satunya
 * alasan hasilnya dibuang adalah karena server sempat menyimpulkan job-nya mati.
 * Menerima laporan yang terlambat mengubah kesimpulan yang salah itu menjadi
 * berkas yang sampai.
 *
 * Filternya `status=eq.failed`, jadi dua laporan terlambat yang berlomba tetap
 * hanya menghasilkan SATU pengiriman: yang kedua mendapat array kosong. Pemanggil
 * WAJIB memastikan lebih dulu bahwa kegagalannya berasal dari penyapu (`error`
 * berawalan `stuck:`) — job yang gagal karena Revit menolak tidak boleh
 * dihidupkan lagi oleh laporan mana pun.
 */
export async function finishLateReport(
  id: string,
  patch: {
    result?: Record<string, unknown> | null;
    doc_title?: string | null;
  },
): Promise<CommandRow | null> {
  const rows = await rest<CommandRow[]>(`commands?id=eq.${id}&status=eq.failed`, {
    method: 'PATCH',
    headers: RETURNING,
    body: JSON.stringify({
      ...patch,
      status: 'done',
      error: null,
      finished_at: new Date().toISOString(),
    }),
  });
  return rows[0] ?? null;
}

export async function queueSnapshot(): Promise<{
  pending: CommandRow[];
  running: CommandRow[];
  doneToday: number;
}> {
  const midnight = startOfLocalDay();

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
