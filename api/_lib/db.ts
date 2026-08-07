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
  /**
   * PC Revit yang melayani user ini. Ada hanya setelah migrasi 006 —
   * lihat `routingReady`. Arti NULL-nya tergantung berapa PC yang terdaftar;
   * yang memutuskan `_lib/routing.ts`.
   */
  machine_id?: string | null;
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
  /** PC tujuan job. Ada hanya setelah migrasi 006 — lihat `routingReady`. */
  machine_id?: string | null;
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
 * Penanda "migrasi ini sudah dijalankan atau belum".
 *
 * Diperiksa, bukan diasumsikan. Kolom atau tabel yang belum ada membuat PostgREST
 * menolak SELURUH request — bukan cuma bagian yang menyentuhnya — jadi tanpa
 * pemeriksaan ini satu langkah SQL yang terlewat mematikan `/claim`, dan
 * bersamanya seluruh bot. Repo ini sudah pernah kehilangan `003_storage.sql`
 * dengan cara yang sama.
 *
 * ── Dua jawaban, dua aturan cache, dan bedanya sudah memakan waktu nyata ──
 *
 * `true` di-cache SELAMANYA: kolom yang sudah ada tidak akan hilang.
 *
 * `false` KEDALUWARSA setelah satu menit. Versi pertama men-cache-nya selamanya
 * juga, dengan alasan "kolomnya tidak akan muncul dan hilang di tengah jalan" —
 * dan alasan itu salah tepat pada satu saat yang paling penting: DETIK MIGRASINYA
 * DIJALANKAN. Instance fungsi yang sudah hangat sebelum itu menyimpan `false`
 * dan tidak pernah memeriksa lagi, jadi migrasi yang sudah benar-benar jalan
 * tetap terbaca "belum" sampai ada redeploy. Yang terlihat dari luar: PC yang
 * tokennya sudah dipasang tetap dijawab 401, tanpa satu pun petunjuk ke arah
 * sini. Itu benar-benar terjadi, dan biayanya satu jam penelusuran.
 *
 * Memeriksa ulang tiap menit menambah dua request per menit per instance —
 * dibanding satu jam salah diagnosa, itu tidak ada artinya.
 */
function migrationFlag(warning: string, probe: () => Promise<unknown>) {
  let ready = false;
  let lastCheck = 0;

  return async function check(): Promise<boolean> {
    if (ready) return true;
    if (Date.now() - lastCheck < 60_000) return false;

    lastCheck = Date.now();
    try {
      await probe();
      ready = true;
    } catch {
      console.warn(`[db] ${warning}`);
    }
    return ready;
  };
}

/** Migrasi 004 — pilihan project per user. */
export const projectSelectionReady = migrationFlag(
  'migrasi 004 belum dijalankan — pilihan project dimatikan',
  async () => {
    await rest('machine_state?id=eq.1&limit=1&select=open_docs');
    await rest('bot_users?limit=1&select=project');
  },
);

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
  /**
   * Boleh muncul di `/active` milik user lain. Ada hanya setelah migrasi 007 —
   * lihat `sharingReady`. Opsional di tipe ini karena `MACHINE_FIELDS` sengaja
   * tidak memintanya; hanya jalur panel yang membacanya.
   */
  shared?: boolean;
}

const MACHINE_FIELDS =
  'id,name,is_active,last_seen_at,active_doc,open_docs,revit_version,addin_version,is_paused,created_at';

/** Migrasi 005 — tabel `machines`. Dipanggil di jalur autentikasi tiap 4 detik. */
export const machinesReady = migrationFlag(
  'migrasi 005 belum dijalankan — daftar PC dimatikan, memakai MACHINE_TOKEN',
  () => rest('machines?limit=1&select=id'),
);

/** Migrasi 006 — routing per-PC. */
export const routingReady = migrationFlag(
  'migrasi 006 belum dijalankan — routing per-PC dimatikan',
  async () => {
    await rest('bot_users?limit=1&select=machine_id');
    await rest('commands?limit=1&select=machine_id');
  },
);

/** Migrasi 007 — penanda PC boleh terlihat user lain. */
export const sharingReady = migrationFlag(
  'migrasi 007 belum dijalankan — /active hanya menampilkan PC sendiri',
  () => rest('machines?limit=1&select=shared'),
);

/**
 * Keadaan SATU PC, dari mana pun sumbernya.
 *
 * Ada karena keadaan itu sekarang bisa datang dari dua tempat: baris `machines`
 * (setelah 005), atau baris tunggal `machine_state` (sebelum itu). Yang membaca —
 * /status, /project, panel, penyapu — tidak perlu tahu yang mana, dan begitu
 * setiap pemanggil harus memilih sendiri, salah satunya akan memilih yang salah.
 *
 * `bot_enabled` SENGAJA tidak ada di sini: ia kill switch GLOBAL, bukan sifat satu
 * PC. Menaruhnya di tipe ini akan mengundang seseorang mematikan bot untuk satu
 * PC dan mengira ia mematikannya untuk semua.
 */
export interface MachineView {
  /** null = dari `machine_state`, belum punya baris `machines` sendiri. */
  id: string | null;
  name: string;
  last_seen_at: string | null;
  active_doc: string | null;
  open_docs: string[] | null;
  revit_version: string | null;
  addin_version: string | null;
  is_paused: boolean;
}

export function viewOfMachine(m: Machine): MachineView {
  return {
    id: m.id,
    name: m.name,
    last_seen_at: m.last_seen_at,
    active_doc: m.active_doc,
    open_docs: m.open_docs ?? [],
    revit_version: m.revit_version,
    addin_version: m.addin_version,
    is_paused: m.is_paused,
  };
}

export function viewOfState(s: MachineState): MachineView {
  return {
    id: null,
    name: 'PC Revit',
    last_seen_at: s.last_seen_at,
    active_doc: s.active_doc,
    open_docs: s.open_docs ?? [],
    revit_version: s.revit_version,
    addin_version: s.addin_version,
    is_paused: s.is_paused,
  };
}

/** Pause/resume satu PC. `id` null → baris tunggal `machine_state` (perilaku lama). */
export async function setPaused(id: string | null, paused: boolean): Promise<void> {
  if (id === null) return updateMachine({ is_paused: paused });
  await rest(`machines?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_paused: paused }),
  });
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
/**
 * PC yang boleh MUNCUL di `/active` milik user lain.
 *
 * `shared` sengaja TIDAK dimasukkan ke `MACHINE_FIELDS`. Daftar kolom itu dipakai
 * juga oleh `findMachineByTokenHash`, yang berjalan di jalur autentikasi tiap 4
 * detik — dan menyebut kolom yang belum ada membuat PostgREST menolak seluruh
 * request. Jadi kalau migrasi 007 terlewat, yang mati akan bukan fitur barunya
 * melainkan SELURUH pengambilan job. Dipisah begini, jalur autentikasi tidak
 * pernah menyentuh kolom yang mungkin belum ada.
 */
export async function listSharedMachines(): Promise<Machine[]> {
  if (!(await sharingReady())) return [];
  return rest<Machine[]>(
    `machines?shared=is.true&is_active=is.true&select=${MACHINE_FIELDS}&order=created_at.asc`,
  );
}

/** Buka/tutup PC dari daftar `/active` orang lain. */
export async function setMachineShared(id: string, shared: boolean): Promise<Machine | null> {
  if (!(await sharingReady())) return null;
  const rows = await rest<Machine[]>(`machines?id=eq.${id}&select=${MACHINE_FIELDS}`, {
    method: 'PATCH',
    headers: RETURNING,
    body: JSON.stringify({ shared }),
  });
  return rows[0] ?? null;
}

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
  /** PC tujuan. Diabaikan kalau migrasi 006 belum dijalankan. */
  machine_id?: string | null;
}): Promise<CommandRow> {
  const { machine_id, ...base } = row;

  // Kolomnya HARUS tidak disebut sama sekali kalau belum ada: menyertakan nama
  // kolom yang tidak dikenal membuat PostgREST menolak seluruh insert, dan yang
  // gagal bukan routing-nya melainkan command user — dengan pesan yang tidak
  // menyebut sebab yang sebenarnya.
  const body = (await routingReady()) ? { ...base, machine_id: machine_id ?? null } : base;

  const rows = await rest<CommandRow[]>('commands', {
    method: 'POST',
    headers: RETURNING,
    body: JSON.stringify([body]),
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
 * Petak antrean yang boleh disentuh satu PC.
 *
 * `null` berarti PC itu belum punya baris `machines` sendiri — ia memakai
 * `MACHINE_TOKEN` dari environment, jadi tidak ada job yang bisa dialamatkan
 * kepadanya dan ia hanya boleh mengambil job yang juga tidak dialamatkan.
 *
 * Itu bukan pembatasan yang kejam, itu satu-satunya jawaban yang benar: kalau PC
 * tanpa identitas dibiarkan mengambil job milik PC lain, seluruh gunanya routing
 * hilang justru pada kasus yang paling mungkin terjadi selama perpindahan.
 */
function scopeFilter(machineId: string | null): string {
  // Job tanpa tujuan ikut boleh diambil PC yang punya identitas: ia berasal dari
  // era sebelum routing ada, dan tidak ada PC lain yang lebih berhak.
  return machineId
    ? `&or=(machine_id.eq.${machineId},machine_id.is.null)`
    : '&machine_id=is.null';
}

/**
 * Ambil satu job FIFO yang dialamatkan ke PC ini, lalu tandai `running`.
 *
 * Filter `status=eq.pending` ikut disertakan pada PATCH, jadi kalau dua proses
 * memperebutkan baris yang sama, hanya satu yang mendapat baris kembali — yang
 * kalah mendapat array kosong.
 *
 * `for update skip locked` yang disebut komentar lama TIDAK diperlukan untuk
 * topologi ini: satu user dipasangkan ke tepat satu PC, dan setiap PC hanya
 * melihat job yang dialamatkan kepadanya, jadi dua PC tidak akan pernah
 * memperebutkan baris yang sama. Yang tersisa hanyalah satu PC dengan dua sesi
 * Revit — dan untuk itu trik di atas memang cukup.
 */
export async function claimNextCommand(machineId: string | null): Promise<CommandRow | null> {
  const scope = (await routingReady()) ? scopeFilter(machineId) : '';

  const pending = await rest<CommandRow[]>(
    `commands?status=eq.pending${scope}&order=created_at.asc&limit=1`,
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
export async function reapRunning(
  olderThanMs: number,
  reason: string,
  /**
   * Batasi ke job milik SATU PC. Tanpa ini, satu /claim dari PC yang idle akan
   * menutup job PC lain yang justru sedang mengekspor 25 sheet — dengan alasan
   * "add-in tidak mengakui job ini", yang benar untuk PC pemanggil dan salah
   * untuk pemilik job-nya. `undefined` = semua job (jalur lama, satu PC).
   */
  scope?: { machineId: string | null },
): Promise<CommandRow[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const filter = scope && (await routingReady()) ? scopeFilter(scope.machineId) : '';

  return rest<CommandRow[]>(
    `commands?status=eq.running&started_at=lt.${cutoff}${filter}`,
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

/**
 * Isi antrean. `scope` membatasinya ke satu PC.
 *
 * Dibatasi karena /status dan /queue sekarang menjawab pertanyaan "apa yang akan
 * dikerjakan PC SAYA" — angka gabungan dari tiga PC akan membuat orang mengira
 * job-nya mengantre di belakang pekerjaan yang sebenarnya berjalan di mesin lain,
 * lalu menunggu tanpa alasan.
 */
export async function queueSnapshot(scope?: { machineId: string | null }): Promise<{
  pending: CommandRow[];
  running: CommandRow[];
  doneToday: number;
}> {
  const midnight = startOfLocalDay();
  const filter = scope && (await routingReady()) ? scopeFilter(scope.machineId) : '';

  const [pending, running, done] = await Promise.all([
    rest<CommandRow[]>(`commands?status=eq.pending${filter}&order=created_at.asc&limit=20`),
    rest<CommandRow[]>(`commands?status=eq.running${filter}&order=created_at.asc&limit=20`),
    rest<{ id: string }[]>(
      `commands?status=eq.done${filter}&finished_at=gte.${midnight.toISOString()}&select=id`,
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
