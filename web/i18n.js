/* ============================================================================
   i18n sisi web. Katalog terpisah dari `api/_lib/i18n` karena isinya beda:
   panel butuh label UI, bot butuh kalimat balasan. Yang disamakan hanyalah
   ATURAN-nya: kunci identik, 'auto' berarti ikut bahasa klien.
   ========================================================================== */

const STORAGE_KEY = 'revitbridge.lang';
const SUPPORTED = ['id', 'en'];
const tg = window.Telegram?.WebApp;
const listeners = new Set();

/* Di-export semata-mata supaya `scripts/check-i18n.ts` bisa membandingkan
   id vs en tanpa mem-parsing berkas ini sebagai teks. Panel sendiri memakai
   `t()`, bukan DICT langsung. */
export const DICT = {
  id: {
    'app.title': 'Revit Bridge',
    'app.subtitle': 'Panel kontrol · elektrikal',
    'status.online': 'PC online',
    'status.offline': 'PC offline',
    'status.paused': 'Di-pause',
    'status.lastSeen': 'Terakhir terlihat',
    'status.model': 'Model terbuka',
    'status.noModel': 'Belum ada model terbuka',
    'status.revit': 'Revit',
    'status.addin': 'Add-in',
    'queue.title': 'Antrean',
    'queue.empty': 'Tidak ada command yang antre.',
    'queue.pending': 'Menunggu',
    'queue.running': 'Berjalan',
    'queue.done': 'Selesai hari ini',
    'cmd.title': 'Command',
    'cmd.hint': 'Ketuk untuk menyalin ke chat.',
    'cmd.copied': 'Disalin',
    'cmd.soon': 'Belum tersedia — add-in Revit belum punya implementasinya.',
    'section.info': 'Info & status',
    'section.query': 'Data model',
    'section.export': 'Export file',
    'section.modify': 'Modifikasi',
    'section.admin': 'Administrasi',
    'pref.title': 'Tampilan',
    'pref.language': 'Bahasa',
    'pref.theme': 'Tema',
    'theme.light': 'Terang',
    'theme.dark': 'Gelap',
    'theme.auto': 'Otomatis',
    'theme.autoNote': 'Otomatis mengikuti tema Telegram / sistem.',
    'role.viewer': 'viewer',
    'role.admin': 'admin',
    'users.title': 'User',
    'users.hint': 'Chat ID dikirim bot saat orangnya mengirim /status.',
    'users.chatId': 'Chat ID',
    'users.name': 'Nama',
    'users.role': 'Peran',
    'users.add': 'Tambah',
    'users.empty': 'Belum ada user.',
    'users.you': 'kamu',
    'users.inactive': 'nonaktif',
    'users.revoke': 'Cabut akses',
    'users.added': 'User disimpan',
    'users.revoked': 'Akses dicabut',
    'users.menuNote': 'Admin baru menerima menu command lengkap setelah /api/admin/setup dibuka lagi.',
    'users.machine': 'PC Revit',
    'users.machineAuto': 'Ikut aturan (satu PC = otomatis)',
    'users.noMachine': 'belum dipasangkan',
    'err.badMachine': 'PC itu tidak ada di daftar.',
    'status.unassigned': 'Belum dipasangkan ke PC mana pun — minta admin memasangkanmu lewat bagian User.',
    'machines.shared': 'dibagikan',
    'machines.private': 'pribadi',
    'machines.shareHint': 'Boleh MUNCUL di /active user lain. Hanya melihat — tidak memberi izin mengirim perintah ke PC ini.',
    'machines.sharedOn': 'PC ini sekarang terlihat di /active',
    'machines.sharedOff': 'PC ini disembunyikan lagi',
    'machines.needsSharing': 'Jalankan dulu supabase/migrations/007_machine_sharing.sql di Supabase.',
    'machines.title': 'PC Revit',
    'machines.hint': 'Token dibuat server. Tidak perlu env var di Vercel.',
    'machines.name': 'Nama PC (mis. PC Budi)',
    'machines.add': 'Tambah PC',
    'machines.empty': 'Belum ada PC terdaftar.',
    'machines.never': 'belum pernah terlihat',
    'machines.inactive': 'dicabut',
    'machines.revoke': 'Cabut izin PC',
    'machines.revoked': 'Izin PC dicabut',
    'machines.added': 'PC terdaftar',
    'machines.tokenOnce': 'Token ini hanya ditampilkan SEKALI. Salin sekarang — yang tersimpan di server cuma hash-nya, jadi tidak bisa ditampilkan lagi. Yang hilang diganti, bukan dipulihkan.',
    'machines.tokenHow': 'Di PC itu: jalankan .\\set-token.ps1 -Token "<token di atas>" lewat Windows PowerShell, lalu TUTUP DAN BUKA LAGI Revit — add-in membaca token sekali per proses.',
    'machines.routingNote': 'Job diarahkan ke PC pemiliknya. Urutan pemasangan: daftarkan dulu PC yang sudah berjalan (pasang tokennya lewat set-token.ps1, restart Revit, pastikan hijau di sini), baru tambah PC berikutnya. Selama masih satu PC, semua job ke sana otomatis — penugasan per user baru perlu diisi setelah ada PC kedua.',
    'machines.needsMigration': 'Jalankan dulu supabase/migrations/005_machines.sql di Supabase.',
    'machines.envOnly': 'PC yang memakai MACHINE_TOKEN dari environment tidak muncul di daftar ini.',
    'err.load': 'Gagal memuat status.',
    'err.loadHint': 'Server tidak bisa dihubungi. Cek koneksi, lalu tekan Muat ulang.',
    'err.noTelegram':
      'Panel ini harus dibuka DARI DALAM Telegram — lewat tombol Panel di sebelah kolom ketik, ' +
      'atau perintah /panelapp. Dibuka langsung sebagai halaman web biasa, Telegram tidak ' +
      'mengirimkan data login, jadi server tidak tahu kamu siapa dan menolak menampilkan status.',
    'err.expired':
      'Sesi panel sudah kedaluwarsa (berlaku 1 jam). Tutup panel ini, lalu buka lagi dari Telegram.',
    'err.badSession':
      'Data login dari Telegram tidak cocok dengan bot di server. Biasanya karena ' +
      'TELEGRAM_BOT_TOKEN di Vercel milik bot yang berbeda dengan bot yang membuka panel ini.',
    'err.notRegistered':
      'Akun Telegram-mu belum terdaftar di bot ini. Kirim /status ke bot, lalu berikan chat ID ' +
      'yang dibalas bot itu kepada admin.',
    'err.server': 'Server sedang bermasalah. Coba lagi sebentar lagi.',
    'err.badChatId': 'Chat ID harus berupa angka.',
    'err.badName': 'Nama tidak boleh kosong.',
    'err.self': 'Kamu tidak bisa mencabut akses dirimu sendiri.',
    'err.notFound': 'Chat ID itu tidak ada di daftar.',
    'err.save': 'Gagal menyimpan. Coba lagi.',
    'action.refresh': 'Muat ulang',
  },
  en: {
    'app.title': 'Revit Bridge',
    'app.subtitle': 'Control panel · electrical',
    'status.online': 'PC online',
    'status.offline': 'PC offline',
    'status.paused': 'Paused',
    'status.lastSeen': 'Last seen',
    'status.model': 'Open model',
    'status.noModel': 'No model open yet',
    'status.revit': 'Revit',
    'status.addin': 'Add-in',
    'queue.title': 'Queue',
    'queue.empty': 'No commands queued.',
    'queue.pending': 'Pending',
    'queue.running': 'Running',
    'queue.done': 'Done today',
    'cmd.title': 'Commands',
    'cmd.hint': 'Tap to copy into the chat.',
    'cmd.copied': 'Copied',
    'cmd.soon': 'Not available yet — the Revit add-in has no implementation for it.',
    'section.info': 'Info & status',
    'section.query': 'Model data',
    'section.export': 'File export',
    'section.modify': 'Modification',
    'section.admin': 'Administration',
    'pref.title': 'Appearance',
    'pref.language': 'Language',
    'pref.theme': 'Theme',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.auto': 'Auto',
    'theme.autoNote': 'Auto follows your Telegram / system theme.',
    'role.viewer': 'viewer',
    'role.admin': 'admin',
    'users.title': 'Users',
    'users.hint': 'The bot replies with a chat ID when they send /status.',
    'users.chatId': 'Chat ID',
    'users.name': 'Name',
    'users.role': 'Role',
    'users.add': 'Add',
    'users.empty': 'No users yet.',
    'users.you': 'you',
    'users.inactive': 'inactive',
    'users.revoke': 'Revoke access',
    'users.added': 'User saved',
    'users.revoked': 'Access revoked',
    'users.menuNote': 'A new admin gets the full command menu once /api/admin/setup is opened again.',
    'users.machine': 'Revit PC',
    'users.machineAuto': 'Follow the rule (one PC = automatic)',
    'users.noMachine': 'not linked',
    'err.badMachine': 'That PC is not on the list.',
    'status.unassigned': 'Not linked to any PC yet — ask an admin to link you in the Users section.',
    'machines.shared': 'shared',
    'machines.private': 'private',
    'machines.shareHint': 'May APPEAR in other users\' /active. Viewing only — grants no permission to send commands to this PC.',
    'machines.sharedOn': 'This PC now shows in /active',
    'machines.sharedOff': 'This PC is hidden again',
    'machines.needsSharing': 'Run supabase/migrations/007_machine_sharing.sql in Supabase first.',
    'machines.title': 'Revit PCs',
    'machines.hint': 'The server generates the token. No Vercel env var needed.',
    'machines.name': 'PC name (e.g. Budi\'s PC)',
    'machines.add': 'Add PC',
    'machines.empty': 'No PCs registered yet.',
    'machines.never': 'never seen',
    'machines.inactive': 'revoked',
    'machines.revoke': 'Revoke this PC',
    'machines.revoked': 'PC access revoked',
    'machines.added': 'PC registered',
    'machines.tokenOnce': 'This token is shown ONCE. Copy it now — the server stores only its hash, so it cannot be shown again. A lost token gets replaced, not recovered.',
    'machines.tokenHow': 'On that PC: run .\\set-token.ps1 -Token "<token above>" in Windows PowerShell, then CLOSE AND REOPEN Revit — the add-in reads the token once per process.',
    'machines.routingNote': 'Jobs are routed to their owner\'s PC. Setup order: first register the PC already running (install its token via set-token.ps1, restart Revit, confirm it turns green here), then add the next PC. While there is only one PC every job goes there automatically — per-user linking is only needed once a second PC exists.',
    'machines.needsMigration': 'Run supabase/migrations/005_machines.sql in Supabase first.',
    'machines.envOnly': 'A PC still using MACHINE_TOKEN from the environment does not appear in this list.',
    'err.load': 'Could not load status.',
    'err.loadHint': 'The server could not be reached. Check your connection, then hit Refresh.',
    'err.noTelegram':
      'This panel has to be opened FROM INSIDE Telegram — via the Panel button next to the ' +
      'message box, or the /panelapp command. Opened as a plain web page, Telegram sends no ' +
      'login data, so the server cannot tell who you are and refuses to show the status.',
    'err.expired':
      'This panel session has expired (it lasts 1 hour). Close the panel and open it again from Telegram.',
    'err.badSession':
      'The login data from Telegram does not match the bot on the server. Usually this means ' +
      'TELEGRAM_BOT_TOKEN on Vercel belongs to a different bot than the one that opened this panel.',
    'err.notRegistered':
      'Your Telegram account is not registered with this bot yet. Send /status to the bot, then ' +
      'give the chat ID it replies with to an admin.',
    'err.server': 'The server is having trouble. Try again shortly.',
    'err.badChatId': 'Chat ID must be a number.',
    'err.badName': 'Name cannot be empty.',
    'err.self': 'You cannot revoke your own access.',
    'err.notFound': 'That chat ID is not on the list.',
    'err.save': 'Could not save. Try again.',
    'action.refresh': 'Refresh',
  },
};

let preference = read();

export function getPreference() { return preference; }

export function locale() {
  if (preference !== 'auto') return preference;
  const code = (tg?.initDataUnsafe?.user?.language_code || navigator.language || 'id')
    .toLowerCase()
    .split('-')[0];
  return SUPPORTED.includes(code) ? code : 'id';
}

export function setPreference(next) {
  if (next !== 'auto' && !SUPPORTED.includes(next)) return;
  preference = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* mode privat */ }
  apply();
}

export function t(key, params = {}) {
  const dict = DICT[locale()] ?? DICT.id;
  const raw = dict[key] ?? DICT.id[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole);
}

/** Terjemahkan ulang seluruh DOM: elemen ber-`data-i18n` diisi teksnya. */
export function apply() {
  document.documentElement.lang = locale();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  }
  // Placeholder merangkap label di form user: kolomnya sempit dan sudah jelas
  // dari konteks, jadi label terpisah hanya menambah tinggi tanpa menambah arti.
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const text = t(el.dataset.i18nPlaceholder);
    el.setAttribute('placeholder', text);
    el.setAttribute('aria-label', text);
  }
  for (const fn of listeners) fn(locale(), preference);
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function read() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'auto' || SUPPORTED.includes(v)) return v;
  } catch { /* abaikan */ }
  return 'auto';
}
