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
   sama dengan `api/_lib/commands.ts`.

   `soon: true` = add-in Revit belum punya implementasinya, jadi server akan
   menolaknya. Tombolnya tetap ada supaya rencananya terlihat, tapi ditandai —
   menawarkan tombol yang pasti gagal adalah cara tercepat membuat orang
   mengira seluruh botnya rusak. Dijaga sinkron oleh scripts/check-commands.ts. */
const COMMANDS = [
  { section: 'info',   name: 'status',   role: 'viewer' },
  { section: 'info',   name: 'levels',   role: 'viewer' },
  { section: 'info',   name: 'sheets',   role: 'viewer' },
  { section: 'info',   name: 'series',   role: 'viewer' },
  { section: 'info',   name: 'views',    role: 'viewer' },
  { section: 'info',   name: 'warnings', role: 'viewer' },
  { section: 'info',   name: 'project',  role: 'viewer' },
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
  { section: 'export', name: 'png',      role: 'viewer' },
  { section: 'export', name: 'schedule', role: 'viewer', arg: 'PANEL-SCH' },
  { section: 'export', name: 'dwg',      role: 'admin',  arg: 'E-101' },
  { section: 'export', name: 'nwc',      role: 'admin' },
  { section: 'export', name: 'ifc',      role: 'admin' },
  { section: 'modify', name: 'setparam', role: 'admin', soon: true },
  { section: 'modify', name: 'tag',      role: 'admin', soon: true },
  { section: 'modify', name: 'dynamo',   role: 'admin', soon: true },
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
 * Daftar PC Revit, dan keterangan seputarnya dari server.
 *
 * `null` berarti GAGAL dimuat, bukan kosong — perbedaan yang sama pentingnya
 * seperti pada `users`: "belum ada PC terdaftar" akan membuat admin mendaftarkan
 * ulang PC yang sebenarnya sudah ada, dan tiap pendaftaran menghasilkan token
 * baru yang membuat token lama di PC itu berhenti bekerja.
 */
let machines = null;
let machinesMeta = null;

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

  if (state?.role === 'admin') await Promise.all([loadUsers(), loadMachines()]);
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

async function loadMachines() {
  try {
    const res = await fetch('/api/panel/machines', { headers: authHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    machines = data.machines ?? [];
    machinesMeta = { ready: data.ready === true, envFallback: data.envFallback === true };
  } catch {
    machines = null;
    machinesMeta = null;
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
  renderMachines();
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

  // Nama PC yang statusnya ditampilkan. Kosong selama masih satu PC.
  document.getElementById('status-pc').textContent = state.pcName ?? '';

  // Belum dipasangkan bukan sama dengan PC mati, dan bedanya menentukan apa yang
  // harus dikerjakan orangnya: yang pertama minta admin, yang kedua buka Revit.
  if (state.unassigned) {
    dot.className = 'dot dot--warn';
    title.textContent = i18n.t('status.offline');
    hint.textContent = i18n.t('status.unassigned');
    hint.hidden = false;
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
      btn.className = c.soon ? 'chip is-soon' : 'chip';
      btn.type = 'button';
      btn.dataset.role = c.role;
      btn.textContent = c.arg ? `/${c.name} ${c.arg}` : `/${c.name}`;
      if (c.soon) btn.title = i18n.t('cmd.soon');
      // Tetap bisa disalin — kadang orang memang ingin mencatat rencananya —
      // tapi ketukannya menjelaskan, bukan membiarkan mereka mengirim command
      // yang sudah pasti ditolak tanpa tahu kenapa.
      btn.addEventListener('click', () => (c.soon ? toast(i18n.t('cmd.soon')) : copyToChat(btn)));
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

    // PC yang melayani user ini. Disebut HANYA kalau ada lebih dari satu PC —
    // selama masih satu, "belum dipasangkan" akan terbaca sebagai masalah yang
    // perlu diperbaiki padahal justru tidak ada yang perlu dipilih.
    if ((machines ?? []).length > 1) {
      const pc = document.createElement('span');
      pc.className = 'muted small';
      pc.textContent = machines.find((m) => m.id === u.machineId)?.name
        ?? i18n.t('users.noMachine');
      li.append(pc);
    }

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

/* ── Daftar PC Revit (admin) ────────────────────────────────────────────── */
function renderMachines() {
  const card = document.getElementById('machines-card');
  card.hidden = state?.role !== 'admin';
  if (card.hidden) return;

  const list = document.getElementById('machine-list');
  const rows = machines ?? [];

  list.replaceChildren(...rows.map((m) => {
    const li = document.createElement('li');
    if (!m.isActive) li.classList.add('is-inactive');

    const name = document.createElement('b');
    name.textContent = m.name;

    // Online dinilai dengan ambang yang sama seperti server (30 detik), supaya
    // panel dan /status tidak pernah menjawab berbeda untuk PC yang sama.
    const fresh = m.lastSeenAt && Date.now() - new Date(m.lastSeenAt).getTime() < 30000;

    const dot = document.createElement('span');
    dot.className = `dot ${m.isActive ? (fresh ? 'dot--ok' : 'dot--err') : 'dot--warn'}`;

    const seen = document.createElement('span');
    seen.className = 'muted small';
    seen.textContent = m.lastSeenAt ? relative(m.lastSeenAt) : i18n.t('machines.never');

    li.append(dot, name, seen);

    if (m.addinVersion) {
      const ver = document.createElement('span');
      ver.className = 'mono small';
      ver.textContent = m.addinVersion;
      li.append(ver);
    }

    if (!m.isActive) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = i18n.t('machines.inactive');
      li.append(tag);
    } else {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.type = 'button';
      btn.textContent = '✕';
      btn.title = i18n.t('machines.revoke');
      btn.setAttribute('aria-label', `${i18n.t('machines.revoke')} — ${m.name}`);
      btn.addEventListener('click', () => revokeMachine(m));
      li.append(btn);
    }
    return li;
  }));

  // Tiga sebab daftar bisa kosong, dan penanganannya berbeda semua: gagal
  // dimuat, migrasi belum jalan, atau memang belum ada PC yang didaftarkan.
  // Satu kalimat untuk ketiganya akan mengirim admin memperbaiki hal yang salah.
  const empty = document.getElementById('machines-empty');
  empty.textContent =
    machines === null ? i18n.t('err.load')
      : machinesMeta && !machinesMeta.ready ? i18n.t('machines.needsMigration')
        : machinesMeta?.envFallback ? `${i18n.t('machines.empty')} ${i18n.t('machines.envOnly')}`
          : i18n.t('machines.empty');
  empty.hidden = rows.length > 0;

  document.getElementById('machine-form').hidden = machinesMeta ? !machinesMeta.ready : false;
  syncMachineOptions();
}

/**
 * Isi dropdown "PC Revit" di form user dari daftar PC.
 *
 * Pilihan yang sedang dipilih dipertahankan kalau PC-nya masih ada. Tanpa itu,
 * daftar yang dimuat ulang tiap 15 detik akan mengembalikan pilihan admin ke
 * "ikut aturan" di tengah ia mengisi form — dan yang tersimpan bukan yang
 * terlihat di layar saat ia menekan Tambah.
 */
function syncMachineOptions() {
  const select = document.getElementById('user-machine');
  const rows = machines ?? [];
  const keep = select.value;

  const options = [
    Object.assign(document.createElement('option'), {
      value: '',
      textContent: i18n.t('users.machineAuto'),
    }),
    ...rows.filter((m) => m.isActive).map((m) =>
      Object.assign(document.createElement('option'), { value: m.id, textContent: m.name })),
  ];

  select.replaceChildren(...options);
  if (options.some((o) => o.value === keep)) select.value = keep;

  // Selama masih satu PC, tidak ada yang perlu dipilih — dan dropdown berisi satu
  // pilihan hanya mengundang orang mengira ada keputusan yang harus diambil.
  select.hidden = rows.length < 2;
}

async function submitMachine(event) {
  event.preventDefault();
  const name = document.getElementById('machine-name');

  let token = null;
  try {
    const res = await fetch('/api/panel/machines', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: name.value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(saveError(data.error));
    token = data.token;

    name.value = '';
    toast(i18n.t('machines.added'));
    tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch {
    return toast(i18n.t('err.save'));
  }

  // Ditampilkan SEBELUM daftar dimuat ulang, dan tidak disembunyikan lagi oleh
  // render berikutnya: ini satu-satunya kesempatan token itu terlihat. Panel
  // memanggil /api/panel/state tiap 15 detik, jadi menaruhnya di jalur render
  // biasa berarti ia hilang dalam hitungan detik.
  const box = document.getElementById('machine-token');
  document.getElementById('machine-token-value').textContent = token ?? '';
  box.hidden = !token;
  if (token) {
    try { await navigator.clipboard.writeText(token); toast(i18n.t('cmd.copied')); } catch { /* izin ditolak */ }
  }

  await loadMachines();
  renderMachines();
}

async function revokeMachine(machine) {
  try {
    const res = await fetch(`/api/panel/machines?id=${encodeURIComponent(machine.id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(saveError(data.error));
    toast(i18n.t('machines.revoked'));
  } catch {
    return toast(i18n.t('err.save'));
  }
  await loadMachines();
  renderMachines();
}

/** Pesan error dari server → kalimat yang bisa dibaca, dalam bahasa aktif. */
function saveError(code) {
  const known = {
    bad_chat_id: 'err.badChatId',
    bad_name: 'err.badName',
    self: 'err.self',
    not_found: 'err.notFound',
    bad_id: 'err.notFound',
    bad_machine: 'err.badMachine',
    needs_migration: 'machines.needsMigration',
  };
  return i18n.t(known[code] ?? 'err.save');
}

async function submitUser(event) {
  event.preventDefault();
  const chatId = document.getElementById('user-chatid');
  const name = document.getElementById('user-name');
  const role = document.getElementById('user-role');
  const machine = document.getElementById('user-machine');

  try {
    const res = await fetch('/api/panel/users', {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        chatId: Number(chatId.value.trim()),
        name: name.value.trim(),
        role: role.value,
        // Kosong = ikut aturan (satu PC → otomatis; beberapa PC → user itu
        // dijawab "belum dipasangkan", bukan ditebak).
        machineId: machine.value || null,
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
document.getElementById('machine-form').addEventListener('submit', submitMachine);
theme.onThemeChange(() => syncTheme());
render();
// Polling dinyalakan/dimatikan oleh `load()` sendiri: memanggil API tiap 15
// detik selama satu jam untuk selalu menerima 401 yang sama tidak menolong
// siapa pun, dan panel yang dibuka di luar Telegram melakukan persis itu.
load();
