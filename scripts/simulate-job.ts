/**
 * Simulasi jalur hasil job, dari add-in sampai Telegram.
 *
 *   npx tsx scripts/simulate-job.ts
 *
 * KENAPA ADA: /pdf pernah "selesai" di Revit lalu tidak pernah sampai ke
 * Telegram, dan tidak ada satu pun penjaga yang bisa menangkapnya. `tsc` hijau,
 * i18n hijau, endpoint termuat — semua benar, dan hasilnya tetap hilang. Yang
 * rusak adalah sesuatu yang hanya terlihat kalau seluruh rantainya dijalankan:
 * body request ke Serverless Function Vercel dibatasi 4,5 MB oleh platform,
 * jadi PDF sheet yang dikirim sebagai base64 ditolak 413 sebelum satu baris
 * handler pun jalan. Add-in mencatatnya sebagai warning, barisnya tetap
 * `running`, dan di chat cuma ada "⏳" yang tidak pernah berubah.
 *
 * Jadi berkas ini menjalankan HANDLER YANG SEBENARNYA — bukan tiruan — di atas
 * Supabase tiruan (lewat HTTP sungguhan, supaya unggah/unduh benar-benar
 * melintasi kabel) dan Telegram tiruan (di dalam proses, supaya isi berkasnya
 * bisa diperiksa byte per byte).
 *
 * Yang dibuktikan:
 *   1. PDF 20 MB sampai UTUH ke Telegram lewat Supabase Storage
 *   2. Berkas kecil tetap lewat jalur inline base64, tanpa storage
 *   3. Body yang dikirim ke /api/machine/report SELALU jauh di bawah 4,5 MB
 *   4. Bucket yang belum dibuat menghasilkan pesan yang menyebut sebabnya
 *   5. Berkas di atas 50 MB ditolak dengan kalimat, bukan didiamkan
 *   6. Laporan ganda tidak mengirim berkas dua kali
 *   7. Objek persinggahan selalu dihapus sesudahnya
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/* ── Supabase tiruan ────────────────────────────────────────────────────── */

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = { commands: [], machine_state: [], bot_users: [] };
const objects = new Map<string, Buffer>();
let bucketExists = true;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** `?id=eq.x&status=eq.running` → predikat. Cukup untuk yang dipakai db.ts. */
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const value = rest.join('.');
    const actual = row[key];
    if (op === 'eq' && String(actual) !== value) return false;
    if (op === 'lt' && !(String(actual) < value)) return false;
    if (op === 'gte' && !(String(actual) >= value)) return false;
    if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      if (!list.includes(String(actual))) return false;
    }
  }
  return true;
}

async function handleSupabase(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  /* ── Storage ── */
  if (url.pathname.startsWith('/storage/v1/')) {
    const rest = url.pathname.slice('/storage/v1/'.length);

    if (rest === 'bucket/job-files') {
      if (!bucketExists) return send(res, 404, { error: 'Bucket not found' });
      return send(res, 200, { id: 'job-files', public: false });
    }

    // Minta signed upload URL.
    if (req.method === 'POST' && rest.startsWith('object/upload/sign/job-files/')) {
      if (!bucketExists) return send(res, 404, { error: 'Bucket not found' });
      const path = rest.slice('object/upload/sign/job-files/'.length);
      return send(res, 200, { url: `/object/upload/sign/job-files/${path}?token=simulasi` });
    }

    // Unggah memakai signed URL — tanpa kredensial, token ada di query.
    if (req.method === 'PUT' && rest.startsWith('object/upload/sign/job-files/')) {
      if (url.searchParams.get('token') !== 'simulasi') return send(res, 401, { error: 'bad token' });
      const path = rest.slice('object/upload/sign/job-files/'.length);
      objects.set(path, await readBody(req));
      return send(res, 200, { Key: `job-files/${path}` });
    }

    if (rest.startsWith('object/job-files/')) {
      const path = rest.slice('object/job-files/'.length);
      if (req.method === 'DELETE') {
        objects.delete(path);
        return send(res, 200, { message: 'deleted' });
      }
      const bytes = objects.get(path);
      if (!bytes) return send(res, 404, { error: 'Object not found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
      return true;
    }
    return send(res, 404, { error: 'no route' });
  }

  /* ── PostgREST ── */
  if (!url.pathname.startsWith('/rest/v1/')) return false;

  const table = url.pathname.slice('/rest/v1/'.length);
  const rows = tables[table];
  if (!rows) return send(res, 404, { error: `no table ${table}` });

  const wanted = rows.filter((r) => matches(r, url.searchParams));

  if (req.method === 'GET') return send(res, 200, wanted);

  if (req.method === 'POST') {
    const incoming = JSON.parse((await readBody(req)).toString() || '[]') as Row[];
    const created = incoming.map((r) => ({
      id: randomUUID(),
      created_at: new Date().toISOString(),
      status: 'pending',
      payload: {},
      tg_message_id: null,
      started_at: null,
      finished_at: null,
      result: null,
      error: null,
      doc_title: null,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      ...r,
    }));
    rows.push(...created);
    return send(res, 201, created);
  }

  if (req.method === 'PATCH') {
    const patch = JSON.parse((await readBody(req)).toString() || '{}') as Row;
    for (const row of wanted) Object.assign(row, patch);
    return send(res, 200, wanted);
  }

  return send(res, 405, { error: 'method' });
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

/* ── Telegram tiruan, di dalam proses ───────────────────────────────────── */

interface Sent { method: string; chatId?: number; text?: string; fileName?: string; bytes?: Buffer }
const sent: Sent[] = [];
let telegramRejects: ((method: string) => string | null) | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('https://api.telegram.org/')) return realFetch(input as never, init);

  const method = url.split('/').pop() ?? '';
  const refusal = telegramRejects?.(method);
  if (refusal) {
    return new Response(JSON.stringify({ ok: false, description: refusal }), { status: 400 });
  }

  if (method === 'sendDocument') {
    const form = init?.body as FormData;
    const blob = form.get('document') as Blob;
    sent.push({
      method,
      chatId: Number(form.get('chat_id')),
      fileName: (blob as File).name ?? String(form.get('document')),
      bytes: Buffer.from(await blob.arrayBuffer()),
    });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
  }

  const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id?: number; text?: string };
  sent.push({ method, chatId: body.chat_id, text: body.text });
  return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
}) as typeof fetch;

/* ── Kerangka Vercel tiruan ─────────────────────────────────────────────── */

interface Captured { status: number; body: unknown }

function invoke(handler: Function, req: Record<string, unknown>): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const captured: Captured = { status: 0, body: null };
    const res = {
      setHeader: () => res,
      status(code: number) { captured.status = code; return res; },
      json(payload: unknown) { captured.body = payload; resolve(captured); return res; },
    };
    Promise.resolve(handler({ method: 'POST', headers: {}, query: {}, ...req }, res)).catch(reject);
  });
}

/* ── Perkakas uji ───────────────────────────────────────────────────────── */

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** PDF palsu yang tidak bisa dikompres, supaya ukurannya jujur. */
function fakePdf(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 2654435761) & 0xff;
  Buffer.from('%PDF-1.7\n').copy(buf, 0);
  return buf;
}

const MB = 1024 * 1024;
const CHAT = 12345;

/** Batas KERAS body request Serverless Function Vercel. */
const VERCEL_BODY_LIMIT = 4.5 * MB;

async function main() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!(await handleSupabase(req, res, url))) send(res, 404, { error: 'no route' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-simulasi';
  process.env.MACHINE_TOKEN = 'machine-token-simulasi';
  process.env.TELEGRAM_BOT_TOKEN = '111:simulasi';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'simulasi';

  // Diimpor SETELAH env dipasang: modul-modulnya membaca env saat dimuat.
  const report = (await import('../api/machine/report')).default;
  const uploadUrl = (await import('../api/machine/upload-url')).default;
  const health = (await import('../api/health')).default;

  const auth = { authorization: 'Bearer machine-token-simulasi' };

  /** Bikin job yang sedang berjalan, seperti sesudah di-claim add-in. */
  function startJob(command: string): { id: string; messageId: number } {
    const id = randomUUID();
    tables.commands.push({
      id, chat_id: CHAT, command, payload: {}, lang: 'id',
      status: 'running', tg_message_id: 900 + tables.commands.length,
      started_at: new Date().toISOString(), finished_at: null,
      result: null, error: null, doc_title: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    return { id, messageId: 900 + tables.commands.length - 1 };
  }

  const jobStatus = (id: string) =>
    (tables.commands.find((r) => r.id === id) as Row | undefined)?.status;

  /**
   * Add-in tiruan: menempuh persis langkah yang ditempuh BridgeClient —
   * termasuk memilih inline vs storage di ambang 3 MB.
   */
  async function addinDelivers(id: string, name: string, bytes: Buffer, text: string) {
    const INLINE_LIMIT = 3 * MB;
    let file: Record<string, string>;

    if (bytes.length <= INLINE_LIMIT) {
      file = { name, base64: bytes.toString('base64') };
    } else {
      const slot = await invoke(uploadUrl, { body: { id, name }, headers: auth });
      if (slot.status !== 200) throw new Error(`upload-url ${slot.status}: ${JSON.stringify(slot.body)}`);
      const { uploadUrl: url, path } = slot.body as { uploadUrl: string; path: string };

      const put = await realFetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' },
        body: new Uint8Array(bytes),
      });
      if (!put.ok) throw new Error(`PUT storage ${put.status}`);
      file = { name, storagePath: path };
    }

    const body = { id, ok: true, text, file, elapsedMs: 184_000 };
    const wire = Buffer.byteLength(JSON.stringify(body));
    const out = await invoke(report, { body, headers: auth });
    return { wire, out };
  }

  console.log('\n1. PDF 20 MB — yang selama ini tidak pernah sampai');
  {
    sent.length = 0;
    const pdf = fakePdf(20 * MB);
    const job = startJob('pdf');
    const { wire, out } = await addinDelivers(job.id, 'PRJ_ME-F-LP-1101.pdf', pdf, '1 sheet: ME-F-LP-1101');

    const doc = sent.find((s) => s.method === 'sendDocument');
    check('job ditutup', jobStatus(job.id) === 'done', String(jobStatus(job.id)));
    check('report menjawab 200', out.status === 200);
    check('pesan ⏳ diedit jadi hasil', sent.some((s) => s.method === 'editMessageText'));
    check('lama proses ikut dilaporkan', !!sent.find((s) => s.text?.includes('menit')));
    check('berkas sampai ke Telegram', !!doc);
    check('isinya utuh', !!doc?.bytes && sha(doc.bytes) === sha(pdf), `${sha(pdf)} vs ${doc ? sha(doc.bytes!) : '—'}`);
    check('ukurannya utuh', doc?.bytes?.length === pdf.length, `${doc?.bytes?.length} B`);
    check(
      `body /report jauh di bawah batas Vercel (${(wire / MB).toFixed(3)} MB < 4,5 MB)`,
      wire < VERCEL_BODY_LIMIT,
    );
    check('objek persinggahan dihapus', objects.size === 0, `${objects.size} tersisa`);

    const oldWay = Buffer.byteLength(JSON.stringify({ id: job.id, ok: true, file: { name: 'x', base64: pdf.toString('base64') } }));
    console.log(`     cara lama: body ${(oldWay / MB).toFixed(1)} MB → ditolak platform Vercel 413`);
  }

  console.log('\n2. Berkas kecil tetap lewat jalur inline, tanpa storage');
  {
    sent.length = 0;
    const csv = fakePdf(200 * 1024);
    const job = startJob('schedule');
    const { wire } = await addinDelivers(job.id, 'PANEL-SCH.csv', csv, 'PANEL-SCH · 42 baris');
    const doc = sent.find((s) => s.method === 'sendDocument');
    check('berkas sampai', !!doc && sha(doc.bytes!) === sha(csv));
    check('storage tidak dipakai sama sekali', objects.size === 0);
    check(`body masih aman (${(wire / MB).toFixed(2)} MB)`, wire < VERCEL_BODY_LIMIT);
  }

  console.log('\n3. Bucket belum dibuat — harus jadi kalimat, bukan kesunyian');
  {
    sent.length = 0;
    bucketExists = false;
    const job = startJob('pdf');
    let raised: string | null = null;
    try {
      await addinDelivers(job.id, 'besar.pdf', fakePdf(10 * MB), 'x');
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }

    // Add-in yang gagal mengunggah tetap WAJIB melapor, membawa alasannya.
    const out = await invoke(report, {
      body: { id: job.id, ok: true, text: 'x', fileError: raised ?? 'gagal' },
      headers: auth,
    });
    check('add-in memang gagal mengunggah', raised !== null, raised?.slice(0, 60) ?? '');
    check('job tetap ditutup, bukan menggantung', jobStatus(job.id) === 'done');
    check('report tetap 200', out.status === 200);
    check(
      'user diberi tahu sebabnya',
      sent.some((s) => s.text?.includes('gagal dikirim')),
      sent.find((s) => s.text?.includes('gagal dikirim'))?.text?.slice(0, 70).replace(/\\/g, '') ?? 'TIDAK ADA',
    );

    const h = await invoke(health, { method: 'GET' });
    const hb = h.body as { ready: boolean; storage: string; storageDetail: string | null };
    check('/api/health menandai storage-nya', hb.storage === 'missing' && hb.ready === false);
    check('…dan menyebut migrasinya', !!hb.storageDetail?.includes('003_storage.sql'));
    bucketExists = true;
  }

  console.log('\n4. Berkas di atas batas Telegram 50 MB');
  {
    sent.length = 0;
    const job = startJob('pdf');
    await addinDelivers(job.id, 'raksasa.pdf', fakePdf(55 * MB), 'x');
    check('job tetap ditutup', jobStatus(job.id) === 'done');
    check('tidak ada upload yang dipaksakan', !sent.some((s) => s.method === 'sendDocument'));
    check('user diberi tahu ukurannya', sent.some((s) => s.text?.includes('55')));
    check('objek persinggahan tetap dibersihkan', objects.size === 0);
  }

  console.log('\n5. Laporan ganda — retry add-in tidak boleh mengirim berkas dua kali');
  {
    sent.length = 0;
    const job = startJob('pdf');
    await addinDelivers(job.id, 'a.pdf', fakePdf(1 * MB), 'x');
    const before = sent.filter((s) => s.method === 'sendDocument').length;
    const again = await invoke(report, {
      body: { id: job.id, ok: true, text: 'x', file: { name: 'a.pdf', base64: fakePdf(1 * MB).toString('base64') } },
      headers: auth,
    });
    const after = sent.filter((s) => s.method === 'sendDocument').length;
    check('laporan pertama mengirim berkas', before === 1);
    check('laporan kedua diabaikan', after === 1, `${after} kiriman`);
    check('ditandai duplikat', (again.body as { duplicate?: boolean }).duplicate === true);
  }

  console.log('\n6. Telegram menolak berkasnya — tetap harus jadi kalimat');
  {
    sent.length = 0;
    telegramRejects = (m) => (m === 'sendDocument' ? 'Bad Request: file is too big' : null);
    const job = startJob('pdf');
    await addinDelivers(job.id, 'b.pdf', fakePdf(6 * MB), 'x');
    check('job tetap ditutup', jobStatus(job.id) === 'done');
    check('user diberi tahu', sent.some((s) => s.text?.includes('gagal dikirim')));
    check('objek persinggahan dihapus walau gagal', objects.size === 0);
    telegramRejects = null;
  }

  console.log('\n7. Otorisasi upload-url');
  {
    const job = startJob('pdf');
    const noAuth = await invoke(uploadUrl, { body: { id: job.id, name: 'x.pdf' }, headers: {} });
    check('tanpa machine token → 401', noAuth.status === 401);

    const unknown = await invoke(uploadUrl, { body: { id: randomUUID(), name: 'x.pdf' }, headers: auth });
    check('job karangan → 404', unknown.status === 404);

    const done = startJob('pdf');
    (tables.commands.find((r) => r.id === done.id) as Row).status = 'done';
    const closed = await invoke(uploadUrl, { body: { id: done.id, name: 'x.pdf' }, headers: auth });
    check('job yang sudah selesai → 409', closed.status === 409);

    const traversal = await invoke(uploadUrl, { body: { id: job.id, name: '../../etc/passwd' }, headers: auth });
    const path = (traversal.body as { path?: string }).path ?? '';
    check('nama berkas tidak bisa kabur dari bucket', !path.includes('..') && !path.includes('/'), path);
  }

  server.close();
  console.log(failures === 0
    ? '\n✅ Seluruh jalur hasil job bekerja — termasuk PDF 20 MB yang selama ini hilang.'
    : `\n❌ ${failures} pemeriksaan gagal.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
