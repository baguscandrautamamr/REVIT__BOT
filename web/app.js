/* ============================================================================
   Panel Revit Bridge — Telegram Mini App / halaman web biasa.
   Merangkai tiga hal: tema (theme.js), bahasa (i18n.js), dan data status.
   ========================================================================== */
import * as theme from './theme.js';
import * as i18n from './i18n.js';

const tg = window.Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();

/* ── Daftar command untuk panel ────────────────────────────────────────────
   Sengaja dijadikan konstanta di sisi klien: panel tetap berguna walau API
   sedang mati, dan tidak ada data sensitif di sini. Urutan & nama harus
   sama dengan `api/_lib/commands.ts`. */
const COMMANDS = [
  { section: 'info',   name: 'status',   role: 'viewer' },
  { section: 'info',   name: 'levels',   role: 'viewer' },
  { section: 'info',   name: 'sheets',   role: 'viewer' },
  { section: 'info',   name: 'warnings', role: 'viewer' },
  { section: 'info',   name: 'queue',    role: 'viewer' },
  { section: 'info',   name: 'help',     role: 'viewer' },
  { section: 'info',   name: 'lang',     role: 'viewer' },
  { section: 'info',   name: 'theme',    role: 'viewer' },
  { section: 'info',   name: 'panelapp', role: 'viewer' },
  { section: 'query',  name: 'count',    role: 'viewer', arg: 'L1' },
  { section: 'query',  name: 'tray',     role: 'viewer', arg: 'L1' },
  { section: 'query',  name: 'panel',    role: 'viewer', arg: 'LP-01' },
  { section: 'query',  name: 'find',     role: 'viewer', arg: 'MARK-123' },
  { section: 'query',  name: 'load',     role: 'viewer', arg: 'L1' },
  { section: 'export', name: 'pdf',      role: 'viewer', arg: 'LP-01' },
  { section: 'export', name: 'png',      role: 'viewer', arg: '3D-ELEC' },
  { section: 'export', name: 'schedule', role: 'viewer', arg: 'PANEL-SCH' },
  { section: 'export', name: 'dwg',      role: 'admin',  arg: 'E-101' },
  { section: 'export', name: 'nwc',      role: 'admin' },
  { section: 'export', name: 'ifc',      role: 'admin' },
  { section: 'modify', name: 'setparam', role: 'admin' },
  { section: 'modify', name: 'tag',      role: 'admin' },
  { section: 'modify', name: 'dynamo',   role: 'admin' },
  { section: 'admin',  name: 'pause',    role: 'admin' },
  { section: 'admin',  name: 'resume',   role: 'admin' },
  { section: 'admin',  name: 'cancel',   role: 'admin' },
  { section: 'admin',  name: 'users',    role: 'admin' },
];

/* ── Segmented control ─────────────────────────────────────────────────── */
function wireSegment(el, getValue, setValue) {
  const buttons = [...el.querySelectorAll('button')];

  function sync() {
    const current = getValue();
    buttons.forEach((b, i) => {
      const on = b.dataset.value === current;
      b.setAttribute('aria-selected', String(on));
      if (on) el.style.setProperty('--index', i);
    });
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setValue(btn.dataset.value);
    tg?.HapticFeedback?.selectionChanged?.();
    sync();
  });

  return sync;
}

const syncLang = wireSegment(
  document.getElementById('lang-segment'),
  () => i18n.getPreference(),
  (v) => { i18n.setPreference(v); render(); },
);

const syncTheme = wireSegment(
  document.getElementById('theme-segment'),
  () => theme.getPreference(),
  (v) => theme.setPreference(v),
);

/* ── Data status ───────────────────────────────────────────────────────── */
let state = null;
let users = null;

/**
 * Sebab kegagalan terakhir, atau null kalau status berhasil dimuat.
 *
 * Dulu ini cuma boolean, dan panel selalu menulis kalimat yang sama: "Gagal
 * memuat status". Padahal penyebabnya berbeda-beda dan penanganannya juga —
 * panel yang dibuka di tab browser biasa (tanpa initData) terlihat persis sama
 * dengan Supabase yang mati, dan orang mencari di tempat yang salah.
 */
let problem = null;

/** Sebab yang tidak akan pulih sendiri: berhenti memanggil API tiap 15 detik. */
const TERMINAL = new Set(['noTelegram', 'expired', 'badSession', 'notRegistered']);

let poll = null;
function startPolling() { poll ??= setInterval(load, 15000); }
function stopPolling() { clearInterval(poll); poll = null; }

// initData dikirim apa adanya; server yang memverifikasi HMAC-nya.
// Jangan pernah percaya `initDataUnsafe` untuk otorisasi.
function authHeaders(extra) {
  return {
    ...(tg?.initData ? { 'x-telegram-init-data': tg.initData } : {}),
    ...extra,
  };
}

async function load() {
  // Tanpa initData, /api/panel/state PASTI menjawab 401 — jadi jangan repot
  // memanggilnya. Dijawab di sini supaya pesannya menyebut sebabnya.
  if (!tg?.initData) {
    state = null;
    problem = 'noTelegram';
    stopPolling();
    render();
    return;
  }

  try {
    const res = await fetch('/api/panel/state', { headers: authHeaders() });
    if (res.ok) {
      state = await res.json();
      problem = null;
    } else {
      const body = await res.json().catch(() => ({}));
      problem = diagnose(res.status, body);
      if (TERMINAL.has(problem)) state = null;
    }
  } catch {
    problem = 'load';
  }

  // Gangguan jaringan atau server pulih sendiri, jadi polling tetap jalan.
  // Sesi yang tidak sah tidak akan pulih tanpa membuka ulang panel.
  if (problem && TERMINAL.has(problem)) stopPolling();
  else startPolling();

  if (state?.role === 'admin') await loadUsers();
  render();
}

/**
 * Kode status + isi balasan → sebab yang bisa dibaca orang.
 * `reason` datang dari `verifyInitData` di server; lihat api/_lib/telegram.ts.
 */
function diagnose(status, body) {
  if (status === 401) {
    if (body.reason === 'stale') return 'expired';
    if (body.reason === 'empty' || body.reason === 'no hash') return 'noTelegram';
    return 'badSession';
  }
  if (status === 403) return 'notRegistered';
  if (status >= 500) return 'server';
  return 'load';
}

async function loadUsers() {
  try {
    const res = await fetch('/api/panel/users', { headers: authHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    users = (await res.json()).users ?? [];
  } catch {
    users = null;
  }
}

/* ── Render ────────────────────────────────────────────────────────────── */
function render() {
  i18n.apply();
  syncLang();
  syncTheme();
  renderStatus();
  renderQueue();
  renderCommands();
  renderUsers();
}

/** Sebab kegagalan → kunci penjelasannya di katalog panel. */
const PROBLEM_HINT = {
  noTelegram: 'err.noTelegram',
  expired: 'err.expired',
  badSession: 'err.badSession',
  notRegistered: 'err.notRegistered',
  server: 'err.server',
  load: 'err.loadHint',
};

function renderStatus() {
  const dot = document.getElementById('status-dot');
  const title = document.getElementById('status-title');
  const hint = document.getElementById('status-hint');

  if (problem || !state) {
    dot.className = 'dot dot--warn';
    title.textContent = problem ? i18n.t('err.load') : '…';
    hint.textContent = problem ? i18n.t(PROBLEM_HINT[problem] ?? 'err.loadHint') : '';
    hint.hidden = !problem;

    // Nilai lama harus ikut dikosongkan. Angka yang bertahan di layar saat
    // status gagal dimuat terbaca sebagai angka yang masih berlaku.
    for (const id of ['kv-model', 'kv-seen', 'kv-revit', 'kv-addin']) {
      document.getElementById(id).textContent = '—';
    }
    return;
  }

  hint.hidden = true;
  const online = state.online === true;
  dot.className = `dot ${online ? (state.isPaused ? 'dot--warn' : 'dot--ok') : 'dot--err'}`;
  title.textContent = online
    ? (state.isPaused ? i18n.t('status.paused') : i18n.t('status.online'))
    : i18n.t('status.offline');

  document.getElementById('kv-model').textContent = state.activeDoc || i18n.t('status.noModel');
  document.getElementById('kv-seen').textContent = state.lastSeenAt ? relative(state.lastSeenAt) : '—';
  document.getElementById('kv-revit').textContent = state.revitVersion || '—';
  document.getElementById('kv-addin').textContent = state.addinVersion || '—';
}

function renderQueue() {
  const q = state?.queue ?? { pending: [], running: [], doneToday: 0 };
  document.getElementById('stat-pending').textContent = q.pending?.length ?? 0;
  document.getElementById('stat-running').textContent = q.running?.length ?? 0;
  document.getElementById('stat-done').textContent = q.doneToday ?? 0;

  const list = document.getElementById('queue-list');
  const items = [...(q.running ?? []), ...(q.pending ?? [])];
  list.replaceChildren(...items.map((job) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${job.status === 'running' ? 'dot--ok' : 'dot--warn'}`;
    const label = document.createElement('span');
    label.className = 'mono';
    label.textContent = `/${job.command}`;
    const time = document.createElement('time');
    time.dateTime = job.createdAt;
    time.textContent = relative(job.createdAt);
    li.append(dot, label, time);
    return li;
  }));
  document.getElementById('queue-empty').hidden = items.length > 0;
}

function renderCommands() {
  const isAdmin = state?.role === 'admin';
  const host = document.getElementById('cmd-sections');
  const sections = ['info', 'query', 'export', 'modify', 'admin'];

  host.replaceChildren(...sections.flatMap((section) => {
    const items = COMMANDS.filter((c) => c.section === section && (isAdmin || c.role === 'viewer'));
    if (!items.length) return [];

    const group = document.createElement('div');
    group.className = 'cmd-group';

    const h3 = document.createElement('h3');
    h3.textContent = i18n.t(`section.${section}`);

    const list = document.createElement('div');
    list.className = 'cmd-list';
    list.append(...items.map((c) => {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.type = 'button';
      btn.dataset.role = c.role;
      btn.textContent = c.arg ? `/${c.name} ${c.arg}` : `/${c.name}`;
      btn.addEventListener('click', () => copyToChat(btn));
      return btn;
    }));

    group.append(h3, list);
    return [group];
  }));
}

/* ── Daftar user (admin) ───────────────────────────────────────────────── */
function renderUsers() {
  const card = document.getElementById('users-card');
  card.hidden = state?.role !== 'admin';
  if (card.hidden) return;

  const list = document.getElementById('user-list');
  const rows = users ?? [];

  list.replaceChildren(...rows.map((u) => {
    const li = document.createElement('li');
    if (!u.isActive) li.classList.add('is-inactive');

    const name = document.createElement('b');
    name.textContent = u.name;

    const id = document.createElement('span');
    id.className = 'mono small';
    id.textContent = u.chatId;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = u.isActive ? i18n.t(`role.${u.role}`) : i18n.t('users.inactive');

    li.append(name, id, tag);

    // Diri sendiri tidak bisa dicabut — server menolaknya juga, tapi tombol
    // yang selalu gagal lebih membingungkan daripada tombol yang tidak ada.
    if (u.chatId === state?.chatId) {
      const you = document.createElement('span');
      you.className = 'muted small';
      you.textContent = i18n.t('users.you');
      li.append(you);
    } else if (u.isActive) {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.type = 'button';
      btn.textContent = '✕';
      btn.title = i18n.t('users.revoke');
      btn.setAttribute('aria-label', `${i18n.t('users.revoke')} — ${u.name}`);
      btn.addEventListener('click', () => revokeUser(u));
      li.append(btn);
    }
    return li;
  }));

  // `users === null` berarti daftarnya GAGAL dimuat, bukan kosong. Menampilkan
  // "Belum ada user" di situ akan membuat admin mengira aksesnya benar-benar
  // hilang dan menambahkan orang yang sebenarnya sudah terdaftar.
  const empty = document.getElementById('users-empty');
  empty.textContent = users === null ? i18n.t('err.load') : i18n.t('users.empty');
  empty.hidden = rows.length > 0;
}

/** Pesan error dari server → kalimat yang bisa dibaca, dalam bahasa aktif. */
function saveError(code) {
  const known = { bad_chat_id: 'err.badChatId', bad_name: 'err.badName', self: 'err.self', not_found: 'err.notFound' };
  return i18n.t(known[code] ?? 'err.save');
}

async function submitUser(event) {
  event.preventDefault();
  const chatId = document.getElementById('user-chatid');
  const name = document.getElementById('user-name');
  const role = document.getElementById('user-role');

  try {
    const res = await fetch('/api/panel/users', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        chatId: Number(chatId.value.trim()),
        name: name.value.trim(),
        role: role.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(saveError(data.error));

    chatId.value = '';
    name.value = '';
    toast(i18n.t('users.added'));
    tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch {
    return toast(i18n.t('err.save'));
  }
  await loadUsers();
  renderUsers();
}

async function revokeUser(user) {
  try {
    const res = await fetch(`/api/panel/users?chatId=${encodeURIComponent(user.chatId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(saveError(data.error));
    toast(i18n.t('users.revoked'));
  } catch {
    return toast(i18n.t('err.save'));
  }
  await loadUsers();
  renderUsers();
}

/* ── Salin ke chat ─────────────────────────────────────────────────────── */
async function copyToChat(btn) {
  const text = btn.textContent;
  try { await navigator.clipboard.writeText(text); } catch { /* izin ditolak */ }
  btn.classList.add('is-copied');
  setTimeout(() => btn.classList.remove('is-copied'), 900);
  toast(i18n.t('cmd.copied'));
  tg?.HapticFeedback?.impactOccurred?.('light');
}

let toastEl;
let toastTimer;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 1400);
}

/* ── Waktu relatif, ikut bahasa aktif ──────────────────────────────────── */
function relative(iso) {
  const rtf = new Intl.RelativeTimeFormat(i18n.locale(), { numeric: 'auto' });
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [
    ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  for (const [unit, sec] of units) {
    if (Math.abs(diff) >= sec || unit === 'second') {
      return rtf.format(Math.round(diff / sec), unit);
    }
  }
  return iso;
}

/* ── Boot ──────────────────────────────────────────────────────────────── */
document.getElementById('refresh').addEventListener('click', load);
document.getElementById('user-form').addEventListener('submit', submitUser);
theme.onThemeChange(() => syncTheme());
render();
// Polling dinyalakan/dimatikan oleh `load()` sendiri: memanggil API tiap 15
// detik selama satu jam untuk selalu menerima 401 yang sama tidak menolong
// siapa pun, dan panel yang dibuka di luar Telegram melakukan persis itu.
load();
