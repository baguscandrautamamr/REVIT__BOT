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
}

/**
 * Sumber tunggal daftar command. Dipakai oleh:
 *   - webhook (routing + cek role)
 *   - /help (pengelompokan per section)
 *   - scripts/set-commands.ts (menu Telegram, per bahasa)
 *   - docs/TELEGRAM-BOT-GUIDE.*.md (dijaga sinkron manual)
 *
 * Nama command sengaja tetap Bahasa Inggris di semua locale: itu yang
 * dikenali menu Telegram lintas bahasa. Yang diterjemahkan adalah
 * DESKRIPSI-nya (lewat `setMyCommands(language_code)`) dan balasannya.
 * Alias Indonesia tetap disediakan untuk yang mengetik manual.
 */
export const COMMANDS: CommandSpec[] = [
  // ── Info & status ──────────────────────────────────────────────────────
  { name: 'status', role: 'viewer', section: 'info', inMenu: true },
  { name: 'levels', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['lantai', 'level'] } },
  { name: 'sheets', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['lembar'] } },
  { name: 'warnings', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['peringatan'] } },
  { name: 'queue', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['antrean', 'antrian'] } },
  // `/start` dikirim otomatis oleh tombol START Telegram saat chat pertama
  // kali dibuka. Tanpa alias ini, interaksi pertama siapa pun dijawab
  // "command tidak dikenal" — kesan pertama yang buruk untuk hal yang bukan
  // kesalahan mereka.
  { name: 'help', role: 'viewer', section: 'info', inMenu: true, aliases: { id: ['bantuan', 'start'], en: ['start'] } },

  // ── Data model ─────────────────────────────────────────────────────────
  {
    name: 'count', role: 'viewer', section: 'query', inMenu: true,
    aliases: { id: ['hitung'] },
    usage: { id: '/count L1 · /count L1 lighting --detail', en: '/count L1 · /count L1 lighting --detail' },
  },
  { name: 'tray', role: 'viewer', section: 'query', inMenu: true, usage: { id: '/tray L1', en: '/tray L1' } },
  { name: 'panel', role: 'viewer', section: 'query', inMenu: true, usage: { id: '/panel LP-01', en: '/panel LP-01' } },
  { name: 'find', role: 'viewer', section: 'query', inMenu: true, aliases: { id: ['cari'] }, usage: { id: '/find MARK-123', en: '/find MARK-123' } },
  { name: 'load', role: 'viewer', section: 'query', inMenu: true, aliases: { id: ['beban'] }, usage: { id: '/load L1', en: '/load L1' } },

  // ── Export ─────────────────────────────────────────────────────────────
  { name: 'pdf', role: 'viewer', section: 'export', inMenu: true, usage: { id: '/pdf LP-01 LP-02', en: '/pdf LP-01 LP-02' } },
  { name: 'png', role: 'viewer', section: 'export', inMenu: true, usage: { id: '/png 3D-ELEC', en: '/png 3D-ELEC' } },
  { name: 'schedule', role: 'viewer', section: 'export', inMenu: true, usage: { id: '/schedule PANEL-SCH', en: '/schedule PANEL-SCH' } },
  { name: 'dwg', role: 'admin', section: 'export', inMenu: false, usage: { id: '/dwg E-101', en: '/dwg E-101' } },
  { name: 'nwc', role: 'admin', section: 'export', inMenu: false },
  { name: 'ifc', role: 'admin', section: 'export', inMenu: false },

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
  const [head, ...rest] = text.trim().split(/\s+/);
  const raw = head.replace(/^\//, '').split('@')[0].toLowerCase();
  return { spec: BY_NAME.get(raw) ?? null, raw, args: rest };
}

export function visibleTo(role: Role): CommandSpec[] {
  return COMMANDS.filter((c) => role === 'admin' || c.role === 'viewer');
}
