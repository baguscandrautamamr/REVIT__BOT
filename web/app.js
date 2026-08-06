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
let failed = false;

async function load() {
  try {
    // initData dikirim apa adanya; server yang memverifikasi HMAC-nya.
    // Jangan pernah percaya `initDataUnsafe` untuk otorisasi.
    const res = await fetch('/api/panel/state', {
      headers: tg?.initData ? { 'x-telegram-init-data': tg.initData } : {},
    });
    if (!res.ok) throw new Error(String(res.status));
    state = await res.json();
    failed = false;
  } catch {
    failed = true;
  }
  render();
}

/* ── Render ────────────────────────────────────────────────────────────── */
function render() {
  i18n.apply();
  syncLang();
  syncTheme();
  renderStatus();
  renderQueue();
  renderCommands();
}

function renderStatus() {
  const dot = document.getElementById('status-dot');
  const title = document.getElementById('status-title');

  if (failed || !state) {
    dot.className = 'dot dot--warn';
    title.textContent = failed ? i18n.t('err.load') : '…';
    return;
  }

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
theme.onThemeChange(() => syncTheme());
render();
load();
setInterval(load, 15000);
