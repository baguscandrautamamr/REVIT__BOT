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
 *   4. Bucket yang belum ada DIBUAT SENDIRI oleh server — tidak ada langkah
 *      SQL manual yang bisa gagal dikerjakan
 *   5. Storage yang benar-benar mati tetap berakhir sebagai kalimat di chat
 *   6. Berkas di atas 50 MB ditolak dengan kalimat, bukan didiamkan
 *   7. Laporan ganda tidak mengirim berkas dua kali
 *   8. Objek persinggahan selalu dihapus sesudahnya
 *   9. upload-url menolak token/job palsu, dan nama berkas tidak bisa kabur
 *      dari bucket lewat "../"
 *  10. Jam di balasan memakai waktu kantor — bukan jam UTC milik Vercel
 *  11. Batas sheet per role tidak bisa dilewati lewat `/pdf --series`
 *  12. Export panjang tidak dibunuh penyapu selama add-in masih mengerjakannya
 *  13. Hasil yang tiba sesudah job disapu tetap dikirim, bukan dibuang
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/* ── Supabase tiruan ────────────────────────────────────────────────────── */

interface Row { [k: string]: unknown }

const tables: Record<string, Row[]> = {
  commands: [], machine_state: [], bot_users: [], tg_updates: [],
};
const objects = new Map<string, Buffer>();
let bucketExists = true;
let bucketsCreated = 0;
let storageDown = false;

/**
 * Bagaimana Storage API menjawab saat bucket-nya belum ada.
 *
 * Ada dua dialek, dan perbedaannya BUKAN kosmetik — ia yang membuat /pdf gagal
 * di produksi sementara berkas ini hijau:
 *
 *   'notFound' — 404 {"error":"Bucket not found"}. Yang dulu ditiru di sini,
 *                dan hanya ini yang dikenali versi pertama api/_lib/storage.ts.
 *
 *   'fkError'  — 400 {"statusCode":"404","error":"InvalidRequest",
 *                     "message":"The related resource does not exist"}
 *                Yang BENAR-BENAR dijawab Supabase yang berjalan sekarang untuk
 *                permintaan signed upload URL. Pembuatan signed URL menguji izin
 *                dengan menyisipkan baris ke `storage.objects`; tanpa baris
 *                bucket-nya, yang gagal adalah FOREIGN KEY — 400, bukan 404.
 *
 * Jalur "buat bucket lalu coba lagi" karenanya tidak pernah jalan sekali pun,
 * dan yang sampai ke chat cuma: HTTP 500 signed upload URL 400.
 */
type MissingDialect = 'notFound' | 'fkError';
let missingDialect: MissingDialect = 'fkError';

/** Batas unggah global proyek. null = tidak ada batas yang menghalangi. */
let globalUploadLimit: number | null = null;
let bucketSizeLimit: number | null = null;

function bucketMissingResponse(res: ServerResponse): true {
  return missingDialect === 'notFound'
    ? send(res, 404, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' })
    : send(res, 400, {
        statusCode: '404',
        error: 'InvalidRequest',
        message: 'The related resource does not exist',
        code: 'InvalidRequest',
      });
}

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
    if (storageDown) return send(res, 503, { error: 'Storage sedang tidak bisa dihubungi' });
    const rest = url.pathname.slice('/storage/v1/'.length);

    if (rest === 'bucket/job-files') {
      if (!bucketExists) return bucketMissingResponse(res);
      return send(res, 200, { id: 'job-files', public: false });
    }

    // Pembuatan bucket lewat Storage API — yang dipakai server supaya tidak
    // ada langkah SQL manual sama sekali.
    if (req.method === 'POST' && rest === 'bucket') {
      const body = JSON.parse((await readBody(req)).toString() || '{}') as {
        id?: string;
        public?: boolean;
        file_size_limit?: number;
      };
      if (body.id !== 'job-files') return send(res, 400, { error: 'bucket lain' });
      if (bucketExists) return send(res, 409, { error: 'Duplicate', message: 'The resource already exists' });
      if (body.public !== false) return send(res, 400, { error: 'bucket harus privat' });

      // Batas unggah global proyek. `file_size_limit` per-bucket tidak boleh
      // melebihinya, dan yang ditolak bukan angkanya — melainkan SELURUH
      // pembuatan bucket-nya.
      if (globalUploadLimit !== null && (body.file_size_limit ?? 0) > globalUploadLimit) {
        return send(res, 400, {
          statusCode: '400',
          error: 'InvalidRequest',
          message: `the requested file_size_limit exceeds the project global upload limit (${globalUploadLimit})`,
        });
      }

      bucketExists = true;
      bucketsCreated++;
      bucketSizeLimit = body.file_size_limit ?? null;
      return send(res, 200, { name: 'job-files' });
    }

    // Minta signed upload URL.
    if (req.method === 'POST' && rest.startsWith('object/upload/sign/job-files/')) {
      if (!bucketExists) return bucketMissingResponse(res);
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
  const { keyHint, keyKind } = await import('../api/_lib/storage');

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

  // Bucket belum ada, DUA DIALEK.
  //
  // Dijalankan dua kali dengan sengaja. Versi pertama berkas ini hanya meniru
  // dialek 404, dan itulah kenapa seluruh pemeriksaan di sini hijau sementara
  // /pdf di produksi menjawab:
  //   HTTP 500 {"error":"internal","detail":"signed upload URL 400: …
  //             The related resource does not exist"}
  // Tiruan yang lebih ramah daripada aslinya bukan penjaga, ia hiasan.
  for (const dialect of ['notFound', 'fkError'] as const) {
    console.log(
      `\n3${dialect === 'notFound' ? '' : 'b'}. Bucket belum ada (dialek ${dialect === 'notFound' ? '404 Bucket not found' : '400 The related resource does not exist'}) — server harus membuatnya sendiri`,
    );
    sent.length = 0;
    missingDialect = dialect;
    bucketExists = false;
    bucketsCreated = 0;
    objects.clear();

    // Persis keadaan yang dialami di lapangan: migrasi SQL-nya gagal
    //   ERROR: 42501: must be owner of table objects
    // jadi tidak ada bucket sama sekali, dan orangnya tidak bisa berbuat apa-apa.
    const h1 = await invoke(health, { method: 'GET' });
    const hb1 = h1.body as { ready: boolean; storage: string; storageDetail: string | null };
    check('/api/health menandai bucket-nya belum ada', hb1.storage === 'missing' && hb1.ready === false);
    check('…dan menyebut jalan keluarnya', !!hb1.storageDetail?.includes('/api/admin/setup'));

    const pdf = fakePdf(12 * MB);
    const job = startJob('pdf');
    const { out } = await addinDelivers(job.id, 'besar.pdf', pdf, '1 sheet');

    const doc = sent.find((s) => s.method === 'sendDocument');
    check('bucket dibuat otomatis', bucketsCreated === 1, `${bucketsCreated}x`);
    check('export TETAP berhasil tanpa SQL manual', out.status === 200 && !!doc);
    check('isinya utuh', !!doc?.bytes && sha(doc.bytes) === sha(pdf));
    check('tidak ada pesan kegagalan ke user', !sent.some((s) => s.text?.includes('gagal dikirim')));

    const h2 = await invoke(health, { method: 'GET' });
    check('/api/health jadi ok sesudahnya', (h2.body as { storage: string }).storage === 'ok');
  }

  console.log('\n3c. Storage benar-benar mati — tetap harus jadi kalimat, bukan kesunyian');
  {
    sent.length = 0;
    storageDown = true;
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
    check('add-in memang gagal mengunggah', raised !== null, raised?.slice(0, 50) ?? '');
    check('job tetap ditutup, bukan menggantung', jobStatus(job.id) === 'done');
    check('report tetap 200', out.status === 200);
    check(
      'user diberi tahu sebabnya',
      sent.some((s) => s.text?.includes('gagal dikirim')),
      sent.find((s) => s.text?.includes('gagal dikirim'))?.text?.slice(0, 60).replace(/\\/g, '') ?? 'TIDAK ADA',
    );
    storageDown = false;
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

  console.log('\n8. Batas unggah global proyek di bawah 50 MB — bucket tetap harus terbentuk');
  {
    sent.length = 0;
    missingDialect = 'fkError';
    bucketExists = false;
    bucketsCreated = 0;
    bucketSizeLimit = null;
    objects.clear();

    // Proyek dengan batas global 25 MB menolak `file_size_limit: 50 MB` — dan
    // yang gagal bukan angkanya, melainkan SELURUH pembuatan bucket-nya. Kalau
    // server menyerah di situ, hasilnya bukan "bucket dengan batas lebih kecil"
    // melainkan tidak ada bucket sama sekali, selamanya.
    globalUploadLimit = 25 * MB;

    const job = startJob('pdf');
    const pdf = fakePdf(12 * MB);
    const { out } = await addinDelivers(job.id, 'besar.pdf', pdf, '1 sheet');
    const doc = sent.find((s) => s.method === 'sendDocument');

    check('bucket tetap terbentuk', bucketExists && bucketsCreated === 1, `${bucketsCreated}x`);
    check('batasnya diserahkan ke proyek', bucketSizeLimit === null, String(bucketSizeLimit));
    check('export berhasil', out.status === 200 && !!doc && sha(doc.bytes!) === sha(pdf));

    globalUploadLimit = null;
  }

  console.log('\n9. Jenis kunci Supabase dikenali — anon key yang salah pasang harus tertangkap');
  {
    // Kombinasi paling menyesatkan yang bisa terjadi: anon key ditempel ke
    // SUPABASE_SERVICE_ROLE_KEY. PostgREST tetap menjawab untuk tabel yang
    // policy-nya longgar, jadi /api/health melaporkan `database: ok` dan
    // semuanya terlihat sehat — sementara SELURUH Storage API menolak, dan
    // gejalanya cuma "berkasnya tidak pernah sampai".
    const jwt = (role: string) =>
      `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.` +
      `${Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url')}.tandatangan`;

    check('service_role JWT dikenali', keyKind(jwt('service_role')) === 'service_role');
    check('anon JWT dikenali sebagai anon', keyKind(jwt('anon')) === 'anon');
    check('kunci rahasia format baru dikenali', keyKind('sb_secret_abc123') === 'secret');
    check('kunci publishable dikenali', keyKind('sb_publishable_abc123') === 'publishable');
    check('kunci kosong dikenali', keyKind('') === 'empty');

    // Petunjuknya harus menyebut apa yang HARUS DILAKUKAN, bukan sekadar
    // memberi nama pada masalahnya.
    const anonHint = keyHint(jwt('anon')) ?? '';
    check('anon key menghasilkan petunjuk yang bisa dikerjakan',
      /service_role/.test(anonHint) && /Redeploy/.test(anonHint), anonHint.slice(0, 60));
    check('service_role key tidak memunculkan petunjuk palsu', keyHint(jwt('service_role')) === null);

    const h = await invoke(health, { method: 'GET' });
    check(
      '/api/health menyebut jenis kuncinya',
      typeof (h.body as { supabaseKeyKind?: string }).supabaseKeyKind === 'string',
      String((h.body as { supabaseKeyKind?: string }).supabaseKeyKind),
    );
  }

  console.log('\n10. Jam di balasan memakai waktu kantor, bukan waktu server');
  {
    // Fungsi Vercel berjalan di UTC. Selama `absoluteTime` tidak menyebut zona
    // waktunya, jam yang tercetak adalah jam UTC — dan /status membacanya
    // sebagai jam dinding. Satu kalimat lalu menyebut dua waktu yang saling
    // bertentangan: "PC offline sejak 6 Agu 2026, 06.47 (2 menit lalu)", untuk
    // PC yang baru saja terlihat. Tidak ada error, tidak ada log, cuma angka
    // yang meyakinkan dan keliru tujuh jam.
    //
    // Zona waktu proses SENGAJA digeser-geser di sini. Versi yang salah lulus
    // di laptop yang kebetulan sudah WIB dan gagal hanya di produksi; dengan
    // TZ yang berpindah, versi yang salah gagal di mana pun ia dijalankan.
    const { statusText, absoluteTime } = await import('../api/_lib/reply');

    const seen = '2026-08-06T13:47:00.000Z'; // 20.47 WIB
    const tzBefore = process.env.TZ;

    process.env.TZ = 'UTC';
    const asUtc = absoluteTime(seen, 'id');
    process.env.TZ = 'America/New_York';
    const asNewYork = absoluteTime(seen, 'id');
    process.env.TZ = tzBefore;

    check('offset kantor dipakai (bukan jam UTC)', asUtc.includes('20.47'), asUtc);
    check('zona waktu server tidak mengubah hasilnya', asUtc === asNewYork,
      `${asUtc} vs ${asNewYork}`);

    // Kalimat lengkapnya: yang mutlak dan yang relatif harus sepakat.
    const text = statusText(
      'id',
      {
        id: 1, last_seen_at: seen, active_doc: null, revit_version: null,
        addin_version: null, is_paused: false, bot_enabled: true,
      },
      { pending: [], running: [] },
    );
    check('/status menyebut jam kantor di kalimat "offline sejak"',
      text.includes('20\\.47'), text.split('\n')[2] ?? text);
  }

  console.log('\n11. Batas sheet per role tidak boleh bisa dilewati lewat --series');
  {
    // Pemeriksaan batas di webhook menghitung panjang daftar sheet yang DIKETIK
    // user. Permintaan per-grup cuma satu kata, jadi pemeriksaan itu selalu
    // lolos — berapa pun isi grupnya. Selama batasnya hanya ada di server,
    // `--series` adalah pintu yang melewatkan aturan yang seharusnya menahan
    // viewer di 10 sheet, dan tidak ada satu pun error yang menandainya:
    // PDF-nya sampai, lengkap, 18 sheet.
    //
    // Yang menutupnya adalah `maxSheets` di dalam payload, ditegakkan add-in
    // sesudah grupnya diterjemahkan. Kalau angka itu hilang dari payload,
    // batasnya hilang sama sekali — jadi keberadaannya diperiksa di sini.
    const webhook = (await import('../api/telegram/webhook')).default;

    tables.machine_state.push({
      id: 1, last_seen_at: new Date().toISOString(), active_doc: 'PRJ.rvt',
      revit_version: '2025', addin_version: '0.1.0', is_paused: false, bot_enabled: true,
    });
    // Satu chat BARU per perintah. `/pdf` termasuk command berat, jadi dua
    // perintah dari chat yang sama akan ditolak cooldown 2 menit — dan yang
    // ditolak cooldown tidak pernah menghasilkan baris untuk diperiksa.
    let nextChat = CHAT + 100;
    async function typed(text: string, updateId: number) {
      const chatId = nextChat++;
      tables.bot_users.push({
        chat_id: chatId, name: `Viewer ${chatId}`, role: 'viewer', is_active: true,
        lang: 'id', theme: 'auto', created_at: new Date().toISOString(),
      });

      sent.length = 0;
      const before = tables.commands.length;
      await invoke(webhook, {
        headers: { 'x-telegram-bot-api-secret-token': 'simulasi' },
        body: { update_id: updateId, message: { chat: { id: chatId }, from: { id: chatId }, text } },
      });
      return tables.commands.slice(before).at(-1) as Row | undefined;
    }

    const group = await typed('/pdf --series "GENERAL-LV"', 1);
    const payload = (group?.payload ?? {}) as Record<string, unknown>;
    check('--series diteruskan sebagai grup, bukan nama sheet',
      payload.series === 'GENERAL-LV' && payload.views === undefined, JSON.stringify(payload));
    check('batas per role IKUT ke add-in — kalau tidak, batasnya hilang',
      payload.maxSheets === 10, String(payload.maxSheets));

    const disc = await typed('/pdf --disc F_UTILITY', 2);
    const discPayload = (disc?.payload ?? {}) as Record<string, unknown>;
    check('--disc juga membawa batasnya',
      discPayload.discipline === 'F_UTILITY' && discPayload.maxSheets === 10,
      JSON.stringify(discPayload));

    // Jalur daftar sheet biasa tidak boleh berubah perilakunya.
    const plain = await typed('/pdf ME-F-EL-0000 ME-F-EL-0100', 3);
    const plainPayload = (plain?.payload ?? {}) as Record<string, unknown>;
    check('daftar sheet biasa tetap tanpa maxSheets',
      Array.isArray(plainPayload.views) && plainPayload.maxSheets === undefined,
      JSON.stringify(plainPayload));

    const tooMany = await typed('/pdf ' + Array.from({ length: 11 }, (_, i) => `S-${i}`).join(' '), 4);
    check('11 sheet yang diketik langsung tetap ditolak di server',
      tooMany === undefined && sent.some((s) => s.text?.includes('10')),
      sent.map((s) => s.text).join(' | ').slice(0, 60));

    // Papan ketik ponsel mengganti "--" jadi em dash SECARA OTOMATIS. Yang
    // sampai ke bot adalah "—disc" — satu karakter — dan versi pertama fitur ini
    // menolaknya, lalu menjawab "Sheet tidak ditemukan: —disc". Benar-benar
    // terjadi pada pemakaian pertama, dari HP, seperti yang seharusnya.
    //
    // Karakternya di bawah ini sengaja em dash dan en dash SUNGGUHAN, bukan
    // "--": penjaga yang mengetik "--" tidak menguji apa pun.
    const em = await typed('/pdf —disc F_UTILTY', 5);
    check('em dash dari autocorrect ponsel dibaca sebagai flag',
      (em?.payload as Record<string, unknown>)?.discipline === 'F_UTILTY',
      JSON.stringify(em?.payload));

    const en = await typed('/pdf –series "GENERAL-LV"', 6);
    check('en dash juga',
      (en?.payload as Record<string, unknown>)?.series === 'GENERAL-LV',
      JSON.stringify(en?.payload));

    const one = await typed('/pdf -series "GROUNDING"', 7);
    check('satu tanda hubung ASCII pun diterima untuk nama flag yang dikenal',
      (one?.payload as Record<string, unknown>)?.series === 'GROUNDING',
      JSON.stringify(one?.payload));

    // /series ada supaya nama grup bisa diketahui tanpa membuka Revit, dan
    // supaya tidak ada tanda hubung yang perlu diketik benar sama sekali —
    // command di menu "/" Telegram bisa ditekan.
    const series = await typed('/series', 9);
    check('/series meminta daftar grup, tanpa flag apa pun',
      (series?.payload as Record<string, unknown>)?.groups === true,
      JSON.stringify(series?.payload));

    const seriesFiltered = await typed('/seri D_FINISHED GOOD WAREHOUSE', 10);
    check('alias /seri + saringan discipline bernama panjang',
      (seriesFiltered?.payload as Record<string, unknown>)?.filter === 'D_FINISHED GOOD WAREHOUSE',
      JSON.stringify(seriesFiltered?.payload));

    const seriesDetail = await typed('/grup —detail', 11);
    check('alias /grup, dan --detail lewat em dash juga',
      (seriesDetail?.payload as Record<string, unknown>)?.detail === true,
      JSON.stringify(seriesDetail?.payload));

    // Yang TIDAK boleh berubah: tanda hubung ada di hampir setiap nomor sheet,
    // jadi nomor sheet tidak boleh ikut terbaca sebagai flag.
    const sheetish = await typed('/pdf -EP-1101 ME-F-EL-0000', 8);
    check('nomor sheet berawalan hubung tetap nomor sheet, bukan flag',
      Array.isArray((sheetish?.payload as Record<string, unknown>)?.views) &&
      ((sheetish?.payload as { views: string[] }).views).includes('-EP-1101'),
      JSON.stringify(sheetish?.payload));
  }

  console.log('\n12. Export panjang tidak boleh dibunuh sementara add-in masih mengerjakannya');
  {
    // Yang benar-benar terjadi: /pdf --disc pada 25 sheet A1. Revit masih di 11%,
    // add-in masih heartbeat tiap 4 detik, dan penyapu menutup job-nya di menit
    // ke-15 dengan "Revit ditutup atau add-in berhenti". Keliru, dan hasil
    // belasan menit kerja Revit dibuang begitu tiba.
    const { sweepAndNotify } = await import('../api/_lib/sweep');
    const claim = (await import('../api/machine/claim')).default;

    /** Job `running` yang started_at-nya digeser ke masa lalu. */
    function ageing(minutes: number): string {
      const id = randomUUID();
      tables.commands.push({
        id, chat_id: CHAT, command: 'pdf', payload: {}, lang: 'id',
        status: 'running', tg_message_id: 700 + tables.commands.length,
        started_at: new Date(Date.now() - minutes * 60_000).toISOString(),
        finished_at: null, result: null, error: null, doc_title: null,
        created_at: new Date(Date.now() - minutes * 60_000).toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      return id;
    }

    // Add-in hidup DAN memegang job → tidak boleh disentuh, walau 45 menit.
    const long = ageing(45);
    await sweepAndNotify({ addinBusy: true });
    check('job 45 menit dibiarkan selama add-in memegangnya', jobStatus(long) === 'running',
      String(jobStatus(long)));

    // Batas atas tetap ada: add-in bisa menggantung selamanya karena satu dialog
    // Revit, dan "⏳" tidak boleh abadi.
    const forever = ageing(3 * 60);
    await sweepAndNotify({ addinBusy: true });
    check('batas atas 2 jam tetap berlaku', jobStatus(forever) === 'failed', String(jobStatus(forever)));
    check('…dan pesannya tidak menuduh Revit ditutup',
      sent.some((s) => s.text?.includes('kelewat lama')),
      sent.filter((s) => s.method === 'editMessageText').map((s) => s.text).join(' | ').slice(0, 70));

    // Add-in hidup tapi TIDAK memegang job apa pun → terlantar, dan ketahuan
    // dalam 2 menit, bukan 15.
    const orphan = ageing(5);
    sent.length = 0;
    await sweepAndNotify({ addinBusy: false });
    check('job terlantar ditutup dalam menit, bukan belasan menit',
      jobStatus(orphan) === 'failed', String(jobStatus(orphan)));
    check('…dan INI yang pantas disebut terputus',
      sent.some((s) => s.text?.includes('Terputus')), String(sent.length));

    // Jalur /claim benar-benar meneruskan `busy` — kalau tidak, seluruh
    // pembedaan di atas tidak pernah aktif di produksi.
    tables.machine_state.length = 0;
    tables.machine_state.push({
      id: 1, last_seen_at: new Date().toISOString(), active_doc: 'PRJ.rvt',
      revit_version: '2025', addin_version: '0.1.0', is_paused: false, bot_enabled: true,
    });
    const viaClaim = ageing(45);
    await invoke(claim, { body: { activeDoc: 'PRJ.rvt', busy: true }, headers: auth });
    check('/claim meneruskan busy ke penyapu', jobStatus(viaClaim) === 'running',
      String(jobStatus(viaClaim)));
  }

  console.log('\n13. Hasil yang tiba sesudah job disapu tetap dikirim, bukan dibuang');
  {
    // Kalau tebakan penyapu keliru, harganya belasan menit kerja Revit. Laporan
    // yang terlambat mengubah kesimpulan yang salah menjadi berkas yang sampai.
    const job = startJob('pdf');
    tables.commands.find((r) => r.id === job.id)!.status = 'failed';
    tables.commands.find((r) => r.id === job.id)!.error = 'stuck: berjalan terlalu lama';

    sent.length = 0;
    const pdf = fakePdf(2 * MB);
    const { out } = await addinDelivers(job.id, 'PRJ_GENERAL-LV_2026-08-06.pdf', pdf, '3 sheet');
    const doc = sent.find((s) => s.method === 'sendDocument');

    check('job jadi selesai, bukan tetap gagal', jobStatus(job.id) === 'done', String(jobStatus(job.id)));
    check('berkasnya benar-benar terkirim', !!doc && sha(doc.bytes!) === sha(pdf));
    check('user diberi tahu hasilnya menyusul',
      sent.some((s) => s.text?.includes('menyusul')),
      sent.filter((s) => s.method === 'editMessageText').map((s) => s.text).join(' | ').slice(0, 70));
    check('report tetap 200', out.status === 200);

    // Yang TIDAK boleh berubah: laporan kedua tetap tidak mengirim ulang berkas.
    const before = sent.filter((s) => s.method === 'sendDocument').length;
    await addinDelivers(job.id, 'PRJ_GENERAL-LV_2026-08-06.pdf', pdf, '3 sheet');
    check('laporan berikutnya tetap diabaikan',
      sent.filter((s) => s.method === 'sendDocument').length === before, `${before}`);

    // Job yang gagal karena REVIT menolak tidak boleh dihidupkan laporan mana pun.
    const rejected = startJob('pdf');
    tables.commands.find((r) => r.id === rejected.id)!.status = 'failed';
    tables.commands.find((r) => r.id === rejected.id)!.error = 'Revit menolak export PDF.';
    const sends = sent.filter((s) => s.method === 'sendDocument').length;
    await addinDelivers(rejected.id, 'x.pdf', fakePdf(1024), 'ok');
    check('kegagalan Revit tidak bisa dihidupkan laporan terlambat',
      jobStatus(rejected.id) === 'failed' &&
      sent.filter((s) => s.method === 'sendDocument').length === sends,
      String(jobStatus(rejected.id)));
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
