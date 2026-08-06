import type { Catalog, Params } from './types';

/**
 * Katalog Bahasa Indonesia — referensi bentuk untuk semua locale lain.
 * Aturan menulis string di sini:
 *   - Tidak ada karakter MarkdownV2 mentah. Formatting dipasang di layer
 *     pengirim (lihat `_lib/telegram.ts` → `mdv2()`), bukan di katalog.
 *   - Placeholder pakai `{nama}`, bukan template literal, supaya bisa
 *     dibandingkan antar-locale oleh `scripts/check-i18n.ts`.
 */
export const id = {
  meta: { nativeName: 'Bahasa Indonesia', bcp47: 'id', flag: '🇮🇩' },

  common: {
    queued: '⏳ Masuk antrean…',
    running: '⚙️ Sedang dikerjakan di Revit…',
    done: '✅ Selesai',
    cancelled: '🚫 Dibatalkan',
    expired: '⌛ Kedaluwarsa — Revit tidak terbuka dalam 10 menit.',
    yes: 'Ya',
    no: 'Batal',
    seconds: (p: Params) => `${p.n} detik`,
    minutes: (p: Params) => `${p.n} menit`,
    elapsed: (p: Params) => `Waktu proses: ${p.duration}`,
    position: (p: Params) => `Antrean posisi ${p.pos} dari ${p.total}`,
    empty: '(kosong)',
  },

  errors: {
    notRegistered:
      'Kamu belum terdaftar. Minta admin menambahkan chat ID kamu: {chatId}',
    inactive: 'Akun kamu dinonaktifkan. Hubungi admin.',
    adminOnly: 'Command ini khusus admin.',
    botDisabled: '🔴 Bot sedang dimatikan sementara oleh admin.',
    unknownCommand: (p: Params) =>
      `Command tidak dikenal: ${p.cmd}. Ketik /help untuk daftar lengkap.`,
    badArgs: (p: Params) => `Format salah.\nContoh benar: ${p.example}`,
    missingArgs: (p: Params) => `Argumen kurang.\nContoh: ${p.example}`,
    tooManySheets: (p: Params) =>
      `Maksimal ${p.max} sheet sekali kirim (kamu minta ${p.asked}).`,
    cooldown: (p: Params) =>
      `Tunggu ${p.seconds} detik lagi — command berat baru saja dijalankan.`,
    pcOffline: (p: Params) =>
      `🔴 PC offline sejak ${p.since} (${p.ago}).\nCommand tetap diantre — jalan otomatis begitu Revit dibuka.`,
    noDocument: 'Revit terbuka tapi belum ada model yang dibuka.',
    docMismatch: (p: Params) =>
      `Model tidak cocok. Yang terbuka sekarang: ${p.actual}`,
    levelNotFound: (p: Params) =>
      `Level "${p.level}" tidak ditemukan. Ketik /levels untuk daftar nama persis.`,
    viewNotFound: (p: Params) => `Sheet/view "${p.view}" tidak ditemukan.`,
    revitError: (p: Params) => `Revit menolak: ${p.message}`,
    fileTooBig: (p: Params) =>
      `File ${p.size} MB melebihi batas kirim Telegram (50 MB). Link unduh: ${p.url}`,
    internal: 'Ada kesalahan internal. Sudah dicatat, coba lagi sebentar.',
  },

  help: {
    title: '⚡ Revit Bridge — daftar command',
    footer:
      'Bot aktif saat Revit terbuka (jam kerja). Bukan layanan 24/7.\nGanti bahasa: /lang · Ganti tema panel: /theme',
    sectionInfo: 'Info & status',
    sectionQuery: 'Data model',
    sectionExport: 'Export file',
    sectionModify: 'Modifikasi (admin)',
    sectionAdmin: 'Administrasi',
    roleNote: (p: Params) => `Role kamu: ${p.role}`,
    hiddenNote: (p: Params) =>
      `${p.n} command lain khusus admin dan disembunyikan.`,
  },

  status: {
    title: '📊 Status',
    online: (p: Params) => `🟢 PC online (terakhir terlihat ${p.ago} lalu)`,
    offline: (p: Params) => `🔴 PC offline sejak ${p.since}`,
    model: (p: Params) => `Model: ${p.title}`,
    noModel: 'Model: — (belum ada dokumen terbuka)',
    revit: (p: Params) => `Revit: ${p.version} · add-in ${p.addin}`,
    queue: (p: Params) => `Antrean: ${p.pending} pending, ${p.running} jalan`,
    paused: '⏸️ Worker sedang di-pause — job tidak diambil.',
  },

  count: {
    header: (p: Params) => `📍 ${p.level}`,
    row: (p: Params) => `${p.label}: ${p.n}`,
    trayLength: (p: Params) => `Cable tray: ${p.n} buah · ${p.meters} m`,
    total: (p: Params) => `Total elemen: ${p.n}`,
    none: (p: Params) => `Tidak ada elemen MEP di ${p.level}.`,
    detailHint: 'Tambahkan --detail untuk pecah per tipe family.',
    catLighting: 'Lampu',
    catReceptacle: 'Stop kontak',
    catCableTray: 'Cable tray',
    catCommunication: 'Komunikasi',
    catFireAlarm: 'Fire alarm',
    catTelephone: 'Telepon',
    catData: 'Data / LAN',
    catSecurity: 'Sekuriti',
  },

  exportFile: {
    starting: (p: Params) => `Mengekspor ${p.n} sheet…`,
    sending: 'Mengirim file…',
    caption: (p: Params) => `${p.project} · ${p.sheet} · ${p.date}`,
    skipped: (p: Params) => `${p.n} sheet dilewati (tidak ditemukan).`,
    slowWarning: 'Format ini lambat — perkiraan 5–15 menit.',
  },

  confirm: {
    prompt: (p: Params) =>
      `⚠️ Akan mengubah ${p.n} elemen.\nTindakan ini tidak bisa di-undo dari Telegram.`,
    expired: 'Konfirmasi kedaluwarsa (2 menit). Jalankan ulang command-nya.',
    notYours: 'Konfirmasi ini milik user lain.',
    applied: (p: Params) => `✅ ${p.n} elemen diubah.`,
  },

  admin: {
    paused: '⏸️ Worker di-pause. Job tetap masuk antrean tapi tidak diambil.',
    resumed: '▶️ Worker jalan lagi.',
    cancelled: (p: Params) => `Command ${p.id} dibatalkan.`,
    notCancellable: 'Command sudah jalan atau sudah selesai — tidak bisa dibatalkan.',
    usersTitle: '👥 User terdaftar',
    userRow: (p: Params) => `${p.name} · ${p.role} · ${p.status}`,
    killSwitchOn: '🔴 Bot dimatikan untuk semua user.',
    killSwitchOff: '🟢 Bot diaktifkan kembali.',
  },

  lang: {
    prompt: 'Pilih bahasa balasan bot:',
    themePrompt: 'Pilih tema panel web:',
    auto: 'Otomatis (ikut bahasa Telegram)',
    changed: (p: Params) => `Bahasa diubah ke ${p.lang}.`,
    unchanged: (p: Params) => `Bahasa sudah ${p.lang}.`,
    current: (p: Params) => `Bahasa saat ini: ${p.lang}`,
  },

  // Dipakai `scripts/set-commands.ts` → setMyCommands(language_code: 'id').
  // Telegram membatasi deskripsi 3–256 karakter dan nama command a-z 0-9 _.
  commandDesc: {
    status: 'Status PC, model terbuka, antrean',
    levels: 'Daftar level di model',
    sheets: 'Daftar sheet + revisi terakhir',
    warnings: 'Warning aktif di model',
    queue: 'Antrean command saat ini',
    help: 'Daftar command sesuai role kamu',
    count: 'Rekap jumlah elemen MEP per lantai',
    tray: 'Panjang cable tray per lantai',
    panel: 'Isi panel schedule',
    find: 'Cari lokasi elemen dari Mark',
    load: 'Total connected load per lantai',
    pdf: 'Export sheet ke PDF skala 1:1',
    png: 'Export view ke gambar PNG',
    dwg: 'Export ke DWG (admin)',
    nwc: 'Export ke NWC untuk Navisworks (admin)',
    ifc: 'Export ke IFC (admin, lambat)',
    schedule: 'Export schedule ke CSV',
    setparam: 'Isi parameter massal (admin)',
    tag: 'Tag otomatis di view aktif (admin)',
    dynamo: 'Jalankan Dynamo graph tersimpan (admin)',
    pause: 'Hentikan pengambilan job (admin)',
    resume: 'Lanjutkan pengambilan job (admin)',
    cancel: 'Batalkan command yang antre (admin)',
    users: 'Daftar user terdaftar (admin)',
    lang: 'Ganti bahasa bot (ID / EN)',
    theme: 'Ganti tema panel web (terang / gelap)',
    panelapp: 'Buka panel web Revit Bridge',
  },
} satisfies Catalog;
