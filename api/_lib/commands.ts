import type { Locale } from './i18n';

export type Role = 'viewer' | 'admin';
export type Section = 'info' | 'query' | 'export' | 'modify' | 'admin';

export interface CommandSpec {
  /** Nama kanonik. HARUS a-z, 0-9, _ dan ≤32 karakter (aturan Telegram). */
  name: string;
  role: Role;
  section: Section;
  /** Alias lokal — supaya `/lantai` bekerja sama dengan `/levels`. */
  aliases?: Partial<Record<Locale, string[]>>;
  /** Contoh pemakaian per bahasa, dipakai di /help dan pesan error argumen. */
  usage?: Partial<Record<Locale, string>>;
  /** Muncul di menu command Telegram (setMyCommands). */
  inMenu: boolean;
  /** Butuh konfirmasi dua langkah sebelum dieksekusi. */
  confirm?: boolean;
  /**
   * Sudah ada implementasinya di add-in Revit.
   *
   * Command yang butuh Revit tapi `addin: false` DITOLAK di server, sebelum
   * masuk antrean. Sebelumnya ia menempuh seluruh perjalanan — Supabase →
   * polling → main thread Revit → report — hanya untuk dijawab "belum
   * diimplementasi", dan kalau PC-nya kebetulan mati ia menggantung 10 menit
   * dulu sebelum kedaluwarsa. Jawabannya sudah diketahui sejak awal.
   *
   * Harus sama dengan daftar di `CommandHandler` (addin/Events/CommandHandler.cs).
   */
  addin?: boolean;
}

/** Command yang dijawab server sendiri, tanpa menyentuh Revit. */
export const SERVER_SIDE = new Set([
  'help', 'status', 'queue', 'lang', 'theme', 'panelapp',
  'users', 'pause', 'resume', 'cancel', 'project',
]);

/** Butuh Revit, tapi add-in belum punya implementasinya. */
export function notImplemented(spec: CommandSpec): boolean {
  return !SERVER_SIDE.has(spec.name) && spec.addin !== true;
}

/**
 * Sumber tunggal daftar command. Dipakai oleh:
 *   - webhook (routing + cek role)
 *   - /help (pengelompokan per section)
 *   - scripts/set-commands.ts (menu Telegram, per bahasa)
 *   - docs/TELEGRAM-BOT-GUIDE.*.md (dijaga sinkron manual)
 *
 * MENAMBAH COMMAND DI SINI TIDAK MENGUBAH MENU "/" DI TELEGRAM.
 *
 * Menu itu disimpan di sisi Telegram, dipasang lewat `setMyCommands`, dan hanya
 * berubah kalau ada yang memasangnya ulang:
 *
 *   buka  https://<domain>/api/admin/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
 *   atau  npx tsx scripts/set-commands.ts
 *
 * Lupa langkah ini tidak menimbulkan error apa pun: command-nya BEKERJA kalau
 * diketik manual, ia hanya tidak muncul di daftar saat orang mengetik "/". Dan
 * karena yang hilang cuma saran pengetikan, tidak ada yang menyadarinya — sampai
 * ada yang bertanya kenapa command yang katanya sudah jadi tidak ada di botnya.
 *
 * Nama command sengaja tetap Bahasa Inggris di semua locale: itu yang
 * dikenali menu Telegram lintas bahasa. Yang diterjemahkan adalah
 * DESKRIPSI-nya (lewat `setMyCommands(language_code)`) dan balasannya.
 * Alias Indonesia tetap disediakan untuk yang mengetik manual.
 */
export const COMMANDS: CommandSpec[] = [
  // ── Info & status ──────────────────────────────────────────────────────
  { name: 'status', role: 'viewer', section: 'info', inMenu: true },
  { name: 'levels', role: 'viewer', section: 'info', inMenu: true, addin: true, aliases: { id: ['lantai', 'level'] } },
  {
    name: 'sheets', role: 'viewer', section: 'info', inMenu: true, addin: true,
    aliases: { id: ['lembar'] },
    usage: { id: '/sheets · /sheets --groups', en: '/sheets · /sheets --groups' },
  },
  // Command sendiri, bukan flag `/sheets --groups`.
  //
  // Nama grup hanya tertulis di browser tree Revit — di PC — sementara yang
  // meminta gambarnya sedang memegang HP. Dan yang muncul di menu "/" Telegram
  // bisa DITEKAN, jadi tidak ada tanda hubung yang bisa diubah autocorrect.
  {
    name: 'series', role: 'viewer', section: 'info', inMenu: true, addin: true,
    aliases: { id: ['seri', 'grup'] },
    usage: { id: '/series · /series D_FINISHED GOOD WAREHOUSE', en: '/series · /series D_FINISHED GOOD WAREHOUSE' },
  },
  // Pasangan /series untuk view, dengan alasan yang sama: nama view 3D hanya
  // tertulis di browser tree Revit. Daftar itu memang sudah muncul saat /png
  // gagal, tapi mengandalkan kegagalan untuk mendapat informasi berarti orangnya
  // harus salah dulu sebelum boleh tahu — dan ia tidak punya cara menebak kata
  // apa yang harus diketik supaya gagalnya cukup informatif.
  {
    name: 'views', role: 'viewer', section: 'info', inMenu: true, addin: true,
    aliases: { id: ['view', 'tampilan'] },
    usage: { id: '/views · /views --all · /views LIGHTING', en: '/views · /views --all · /views LIGHTING' },
  },
  { name: 'warnings', role: 'viewer', section: 'info', inMenu: true, addin: true, aliases: { id: ['peringatan'] } },
  // Dijawab server, bukan Revit: daftar file terbukanya sudah ada di
  // machine_state lewat heartbeat, dan pilihan yang butuh satu siklus polling
  // untuk muncul akan berhenti dipakai orang.
  {
    name: 'project', role: 'viewer', section: 'info', inMenu: true,
    aliases: { id: ['proyek', 'file'] },
    usage: { id: '/project · /project WAREHOUSE', en: '/project · /project WAREHOUSE' },
  },
  { name: 'queue', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['antrean', 'antrian'] } },
  // `/start` dikirim otomatis oleh tombol START Telegram saat chat pertama
  // kali dibuka. Tanpa alias ini, interaksi pertama siapa pun dijawab
  // "command tidak dikenal" — kesan pertama yang buruk untuk hal yang bukan
  // kesalahan mereka.
  { name: 'help', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['bantuan', 'start'], en: ['start'] } },

  // ── Data model ─────────────────────────────────────────────────────────
  {
    name: 'count', role: 'viewer', section: 'query', inMenu: true, addin: true,
    aliases: { id: ['hitung'] },
    usage: {
      id: '/count L1 · /count L1 lighting --detail · /count L1 --csv',
      en: '/count L1 · /count L1 lighting --detail · /count L1 --csv',
    },
  },
  {
    name: 'tray', role: 'viewer', section: 'query', inMenu: true, addin: true,
    usage: { id: '/tray L1 · /tray L1 --type', en: '/tray L1 · /tray L1 --type' },
  },
  { name: 'panel', role: 'viewer', section: 'query', inMenu: true, addin: true, usage: { id: '/panel LP-01', en: '/panel LP-01' } },
  { name: 'find', role: 'viewer', section: 'query', inMenu: true, addin: true, aliases: { id: ['cari'] }, usage: { id: '/find MARK-123', en: '/find MARK-123' } },
  { name: 'load', role: 'viewer', section: 'query', inMenu: true, addin: true, aliases: { id: ['beban'] }, usage: { id: '/load L1', en: '/load L1' } },

  // ── Export ─────────────────────────────────────────────────────────────
  {
    name: 'pdf', role: 'viewer', section: 'export', inMenu: true, addin: true,
    usage: {
      id: '/pdf LP-01 LP-02 · /pdf --series "GENERAL-LV"',
      en: '/pdf LP-01 LP-02 · /pdf --series "GENERAL-LV"',
    },
  },
  // Contoh usage-nya sengaja TIDAK menyebut nama view karangan. Versi
  // sebelumnya menulis "/png 3D-ELEC" — nama yang tidak ada di model mana pun,
  // saya karang sendiri — dan orang yang menyalinnya apa adanya dijawab "view
  // tidak ditemukan" untuk kesalahan yang bukan miliknya.
  {
    name: 'png', role: 'viewer', section: 'export', inMenu: true, addin: true,
    usage: { id: '/png · /png --3d', en: '/png · /png --3d' },
  },
  { name: 'schedule', role: 'viewer', section: 'export', inMenu: true, addin: true, usage: { id: '/schedule PANEL-SCH', en: '/schedule PANEL-SCH' } },
  {
    name: 'dwg', role: 'admin', section: 'export', inMenu: false, addin: true,
    usage: { id: '/dwg E-101 · /dwg --series "GROUNDING"', en: '/dwg E-101 · /dwg --series "GROUNDING"' },
  },
  { name: 'nwc', role: 'admin', section: 'export', inMenu: false, addin: true },
  { name: 'ifc', role: 'admin', section: 'export', inMenu: false, addin: true },

  // ── Modifikasi (selalu dua langkah) ────────────────────────────────────
  { name: 'setparam', role: 'admin', section: 'modify', inMenu: false, confirm: true, usage: { id: '/setparam L1 tray Comments "LV LADDER"', en: '/setparam L1 tray Comments "LV LADDER"' } },
  { name: 'tag', role: 'admin', section: 'modify', inMenu: false, confirm: true },
  { name: 'dynamo', role: 'admin', section: 'modify', inMenu: false, confirm: true, usage: { id: '/dynamo nama-graph', en: '/dynamo graph-name' } },

  // ── Administrasi ───────────────────────────────────────────────────────
  { name: 'pause', role: 'admin', section: 'admin', inMenu: false },
  { name: 'resume', role: 'admin', section: 'admin', inMenu: false },
  { name: 'cancel', role: 'admin', section: 'admin', inMenu: false, usage: { id: '/cancel 3f9a', en: '/cancel 3f9a' } },
  { name: 'users', role: 'admin', section: 'admin', inMenu: false },

  // ── Preferensi per user ────────────────────────────────────────────────
  { name: 'lang', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['bahasa'] }, usage: { id: '/lang id · /lang en · /lang auto', en: '/lang en · /lang id · /lang auto' } },
  { name: 'theme', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['tema'] }, usage: { id: '/theme light · /theme dark · /theme auto', en: '/theme light · /theme dark · /theme auto' } },
  { name: 'panelapp', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['panelweb'] } },
];

const BY_NAME = new Map<string, CommandSpec>();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const list of Object.values(c.aliases ?? {})) {
    for (const a of list) BY_NAME.set(a, c);
  }
}

/** Terima `/count@MyBot L1` maupun `/hitung L1`. */
export function parseCommand(text: string): { spec: CommandSpec | null; raw: string; args: string[] } {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? '' : trimmed.slice(space + 1);

  const raw = head.replace(/^\//, '').split('@')[0].toLowerCase();
  return { spec: BY_NAME.get(raw) ?? null, raw, args: tokenize(rest) };
}

/**
 * Nama flag yang dikenal seluruh command. Dipakai HANYA untuk memutuskan apakah
 * satu tanda hubung tunggal dimaksudkan sebagai flag — lihat `flagName`.
 */
export const KNOWN_FLAGS = new Set([
  'series', 'disc', 'discipline', 'groups', 'grup', 'detail', '3d', 'all',
  'csv', 'type',
]);

/**
 * Karakter yang orang MAKSUDKAN sebagai `--` saat mengetik di ponsel.
 *
 * Papan ketik iOS dan Android mengganti dua tanda hubung berurutan dengan em
 * dash, otomatis dan tanpa memberi tahu. Yang sampai ke bot bukan `--disc`
 * melainkan `—disc` — SATU karakter — dan `startsWith('--')` menolaknya. Katanya
 * lalu jatuh ke daftar nama sheet, dan yang dibalas bot adalah
 * "Sheet tidak ditemukan: —disc": pesan yang benar untuk pertanyaan yang salah,
 * sebab yang salah bukan nama sheet-nya melainkan tanda hubungnya.
 *
 * Ini bukan kerewelan. Bot ini dipakai DARI PONSEL — itu seluruh alasannya ada.
 * Flag yang hanya bisa diketik dari papan ketik fisik sama saja dengan flag yang
 * tidak pernah dibuat.
 */
const DASHES = '—–―‒−'; // em, en, horizontal bar, figure dash, minus
const LEADING_DASHES = new RegExp(`^[-${DASHES}]+`);

/**
 * Token → nama flag, atau null kalau ia argumen biasa.
 *
 * Tanda hubung ASCII TUNGGAL sengaja diperlakukan berbeda: ia ada di hampir
 * setiap nomor sheet di proyek ini (`ME-F-EP-1101`), jadi menerimanya tanpa
 * syarat akan mengubah nomor sheet jadi flag. Ia hanya diterima kalau sisanya
 * memang nama flag yang dikenal — dan tidak ada papan ketik yang mengubah `--`
 * menjadi satu tanda hubung ASCII, jadi jalur itu murni salah ketik manusia.
 */
function flagName(token: string): string | null {
  const lead = token.match(LEADING_DASHES)?.[0] ?? '';
  if (!lead) return null;

  const rest = token.slice(lead.length).toLowerCase();
  if (!rest) return null;

  // Dua tanda hubung, atau satu dash Unicode apa pun (hasil autocorrect).
  if (lead.length >= 2 || DASHES.includes(lead)) return rest;

  // Satu tanda hubung ASCII: hanya kalau memang nama flag.
  return KNOWN_FLAGS.has(rest) ? rest : null;
}

/**
 * Pisahkan argumen jadi yang positional dan yang flag.
 *
 * Dipakai bersama supaya `--series` di /pdf dan `--detail` di /count tidak bisa
 * menyimpang aturannya — dan supaya perbaikan em dash di atas berlaku untuk
 * SEMUA flag sekaligus, bukan cuma yang kebetulan diingat.
 */
export function splitArgs(args: string[]): { positional: string[]; flags: string[] } {
  const positional: string[] = [];
  const flags: string[] = [];

  for (const arg of args) {
    const name = flagName(arg);
    if (name === null) positional.push(arg);
    else flags.push(name);
  }

  return { positional, flags };
}

/**
 * Pecah argumen, dengan `"..."` sebagai satu token.
 *
 * Nama di proyek nyata mengandung spasi — level "GROUND FLOOR", schedule
 * "PANEL SCHEDULE DB-UTILTY", sheet "GROUND & FIRST FLOOR". Memecah begitu saja
 * pada spasi membuat `/count GROUND FLOOR lighting` terbaca sebagai
 * level="GROUND", kategori="FLOOR" — dan karena tidak ada kategori bernama
 * "FLOOR", jawabannya "tidak ada elemen MEP di lantai ini" untuk lantai yang
 * sebenarnya penuh. Salah yang tidak terlihat salah.
 *
 * Tanda kutip di sini adalah jalan keluar eksplisitnya. Untuk command yang
 * hanya menerima SATU nama, `webhook.ts` menggabungkan kembali seluruh token
 * jadi tanda kutipnya bahkan tidak diperlukan.
 */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  // Satu token = teks dalam kutip ganda, dalam kutip tunggal, atau tanpa spasi.
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (value) out.push(value);
  }
  return out;
}
