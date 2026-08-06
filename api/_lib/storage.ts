/**
 * Supabase Storage — persinggahan berkas hasil export.
 *
 * Ada semata-mata karena batas 4,5 MB pada body request Serverless Function
 * Vercel. Lihat catatan panjang di `supabase/migrations/003_storage.sql`:
 * mengirim PDF sebagai base64 ke /api/machine/report TIDAK BISA bekerja untuk
 * berkas berukuran nyata, dan kegagalannya senyap total.
 *
 * Alurnya sekarang:
 *   add-in → minta signed upload URL ke server   (JSON kecil, lewat Vercel)
 *   add-in → PUT berkasnya ke Supabase           (LANGSUNG, tidak lewat Vercel)
 *   add-in → /report menyebut path-nya saja      (JSON kecil, lewat Vercel)
 *   server → unduh dari Supabase, kirim Telegram, hapus
 *
 * Arah unduh tidak dibatasi 4,5 MB — yang dibatasi platform hanya body request
 * yang MASUK ke fungsi.
 */
import { ENV } from './env';

export const BUCKET = 'job-files';

/** Batas upload bot Telegram; sama dengan file_size_limit bucket. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

function base(): string {
  return `${ENV.supabaseUrl}/storage/v1`;
}

function headers(): Record<string, string> {
  return {
    apikey: ENV.supabaseKey,
    authorization: `Bearer ${ENV.supabaseKey}`,
  };
}

/**
 * "Bucket-nya tidak ada" — apa pun bungkus HTTP yang dipakai Supabase.
 *
 * Ini bukan kerewelan. Storage API TIDAK selalu menjawab 404 untuk bucket yang
 * belum ada, dan versi yang sekarang berjalan menjawab 400 untuk permintaan
 * signed upload URL:
 *   HTTP 400 {"statusCode":"404","error":"InvalidRequest",
 *             "message":"The related resource does not exist","code":"InvalidRequest"}
 * Penyebabnya di dalam: pembuatan signed URL menguji izin dengan menyisipkan
 * baris ke `storage.objects`, dan tanpa baris bucket-nya yang gagal adalah
 * FOREIGN KEY (Postgres 23503) — yang diterjemahkan storage-api menjadi 400,
 * bukan 404.
 *
 * Versi pertama kode ini hanya memeriksa `res.status === 404`, jadi jalur
 * "buat bucket lalu coba lagi" TIDAK PERNAH jalan: setiap export besar mati di
 * percobaan pertama dengan 400, dan bucket-nya tidak pernah terbentuk sendiri
 * seperti yang dijanjikan komentar di bawah. Yang menentukan sekarang adalah
 * ISI balasannya, bukan angka status di luarnya.
 */
function meansBucketMissing(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /bucket not found|no such bucket|related resource does not exist|"statusCode":\s*"?404/i.test(
    body,
  );
}

export type KeyKind = 'service_role' | 'anon' | 'secret' | 'publishable' | 'empty' | 'unknown';

/**
 * Jenis kunci Supabase yang dipegang server — dibaca dari bentuknya, bukan
 * dari nilainya, dan tidak pernah mengeluarkan isinya.
 *
 * Ada karena satu salah pasang yang sangat mudah dilakukan dan sangat sulit
 * dikenali: menempelkan ANON key ke SUPABASE_SERVICE_ROLE_KEY. PostgREST tetap
 * menjawab untuk tabel yang policy-nya longgar — jadi /api/health melaporkan
 * `database: ok` dan semuanya terlihat sehat — sementara seluruh Storage API
 * menolak diam-diam. Gejalanya hanya "berkasnya tidak pernah sampai".
 */
export function keyKind(key: string = ENV.supabaseKey): KeyKind {
  if (!key) return 'empty';

  // Format kunci baru Supabase (sb_secret_… / sb_publishable_…).
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable';

  // Format lama: JWT. Payload-nya dibaca APA ADANYA — tanpa verifikasi tanda
  // tangan, karena yang dicari cuma `role` untuk keperluan diagnosa.
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
        role?: string;
      };
      if (payload.role === 'service_role') return 'service_role';
      if (payload.role === 'anon') return 'anon';
    } catch {
      // Bukan JWT yang bisa dibaca — biar jatuh ke 'unknown'.
    }
  }
  return 'unknown';
}

/** Petunjuk kalau kuncinya jelas salah jenis. null = tidak ada yang perlu disebut. */
export function keyHint(key: string = ENV.supabaseKey): string | null {
  switch (keyKind(key)) {
    case 'empty':
      return 'SUPABASE_SERVICE_ROLE_KEY kosong.';
    case 'anon':
      return (
        'SUPABASE_SERVICE_ROLE_KEY berisi ANON key, bukan service_role key. ' +
        'Anon key tidak boleh menyentuh Storage sama sekali. Ambil yang benar di ' +
        'Supabase → Project Settings → API → service_role, lalu Redeploy.'
      );
    case 'publishable':
      return (
        'SUPABASE_SERVICE_ROLE_KEY berisi kunci publishable (sb_publishable_…), ' +
        'bukan kunci rahasia. Yang dibutuhkan adalah secret key (sb_secret_…) ' +
        'atau service_role key, lalu Redeploy.'
      );
    default:
      return null;
  }
}

/** Tempelkan petunjuk kunci ke pesan error, kalau memang ada yang salah. */
function withKeyHint(message: string): string {
  const hint = keyHint();
  return hint ? `${message} — ${hint}` : message;
}

/**
 * Path objek untuk satu job. Diturunkan dari id job, bukan dari nama berkas
 * yang datang dari add-in: nama berkas berasal dari judul dokumen Revit, dan
 * memakainya apa adanya sebagai path adalah cara termudah kabur dari bucket
 * lewat "../". Nama aslinya tetap dipakai saat mengirim ke Telegram — di sana
 * ia cuma label, bukan path.
 */
export function objectPath(jobId: string, fileName: string): string {
  const ext = (fileName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
  const safeId = jobId.replace(/[^A-Za-z0-9-]/g, '');
  return `${safeId}.${ext}`;
}

/**
 * Buat bucket-nya kalau belum ada.
 *
 * Ada supaya tidak ada langkah manual sama sekali. Versi pertama menyerahkan
 * ini ke migrasi SQL, dan itu salah dua kali: SQL Editor Supabase berjalan
 * sebagai role `postgres`, yang BUKAN pemilik `storage.objects` — perintah
 * `alter table storage.objects …` di sana dijawab
 *   ERROR: 42501: must be owner of table objects
 * dan karena SQL Editor menjalankan seluruh skrip dalam satu transaksi,
 * pembuatan bucket-nya ikut di-rollback. Hasilnya: orang mengira sudah
 * menjalankan migrasinya, padahal tidak ada yang terbentuk.
 *
 * Service role key yang dipegang server ini punya izin penuh atas Storage API,
 * jadi ia bisa mengurusnya sendiri — dan itu satu langkah pemasangan yang tidak
 * bisa lagi salah dikerjakan.
 */
export async function ensureBucket(): Promise<void> {
  const first = await create(MAX_FILE_BYTES);
  if (first === null) return;

  // `file_size_limit` per-bucket tidak boleh melebihi batas unggah global
  // proyek. Kalau proyeknya disetel di bawah 50 MB, Supabase menolak seluruh
  // pembuatan bucket-nya — dan hasilnya bukan "bucket dengan batas lebih kecil",
  // melainkan TIDAK ADA BUCKET SAMA SEKALI. Batas globalnya lebih penting untuk
  // dihormati daripada angka pilihan kita: coba lagi tanpa menyebut batas, biar
  // proyeknya sendiri yang menentukan.
  if (/size|limit|exceed/i.test(first)) {
    const second = await create(null);
    if (second === null) {
      console.warn(
        `[storage] bucket "${BUCKET}" dibuat tanpa file_size_limit — batas unggah ` +
          `global proyek menolak ${MAX_FILE_BYTES} byte: ${first.slice(0, 200)}`,
      );
      return;
    }
    throw new Error(withKeyHint(`buat bucket ${BUCKET} gagal: ${second.slice(0, 300)}`));
  }

  throw new Error(withKeyHint(`buat bucket ${BUCKET} gagal: ${first.slice(0, 300)}`));
}

/** null = bucket sudah siap. String = alasan gagalnya, untuk dibaca pemanggil. */
async function create(sizeLimit: number | null): Promise<string | null> {
  const res = await fetch(`${base()}/bucket`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      // PRIVAT. Anon key boleh dipegang siapa saja yang membuka panel; ia tidak
      // boleh bisa mengunduh gambar kerja hanya karena menebak nama berkasnya.
      public: false,
      ...(sizeLimit === null ? {} : { file_size_limit: sizeLimit }),
    }),
  });

  if (res.ok) {
    console.log(`[storage] bucket "${BUCKET}" dibuat`);
    return null;
  }

  // Sudah ada = tujuan tercapai. Dua proses yang berlomba membuatnya bukan
  // kesalahan, dan Supabase menjawabnya 409 atau 400 tergantung versi.
  const body = await res.text();
  if (res.status === 409 || /exists|duplicate/i.test(body)) return null;

  return `HTTP ${res.status} ${body}`;
}

/**
 * URL unggah bertanda tangan, berlaku singkat.
 *
 * Add-in memakainya tanpa kredensial apa pun — token-nya ada di query string.
 * Itu disengaja: service role key TIDAK BOLEH pernah sampai ke PC Revit.
 */
export async function createUploadUrl(path: string): Promise<{ url: string; token: string }> {
  let res = await sign(path);

  // Bucket belum ada → buat, lalu coba sekali lagi. Export pertama yang cukup
  // besar akan memasangnya sendiri; tidak ada yang perlu diingat lebih dulu.
  //
  // Yang diperiksa adalah ISI balasannya, bukan angka statusnya — lihat
  // `meansBucketMissing`. Selama pemeriksaannya `status === 404`, jalur ini
  // tidak pernah jalan sekali pun.
  if (!res.ok && meansBucketMissing(res.status, res.body)) {
    await ensureBucket();
    res = await sign(path);
  }

  if (!res.ok) {
    throw new Error(
      withKeyHint(`signed upload URL ${res.status}: ${res.body.slice(0, 300)}`),
    );
  }

  // Balasannya { url: "/object/upload/sign/<bucket>/<path>?token=..." }
  const parsed = JSON.parse(res.body) as { url?: string };
  if (!parsed.url) throw new Error('signed upload URL: balasan tanpa url');

  const token = new URLSearchParams(parsed.url.split('?')[1] ?? '').get('token') ?? '';
  return { url: `${base()}${parsed.url}`, token };
}

/**
 * Body-nya ikut dikembalikan, bukan Response-nya.
 *
 * Sengaja: keputusan "bucket-nya belum ada" hanya bisa diambil setelah membaca
 * body, dan body sebuah Response cuma boleh dibaca sekali. Mengembalikan
 * Response mentah membuat pemanggilnya harus memilih antara memeriksa isinya
 * atau melaporkannya — dan versi sebelumnya memilih salah.
 */
async function sign(path: string): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(`${base()}/object/upload/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export async function download(path: string): Promise<Buffer> {
  const res = await fetch(`${base()}/object/${BUCKET}/${path}`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`unduh ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Gagal menghapus bukan alasan menggagalkan pengiriman yang sudah berhasil. */
export async function remove(path: string): Promise<void> {
  try {
    const res = await fetch(`${base()}/object/${BUCKET}/${path}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) console.warn(`[storage] hapus ${path} gagal: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[storage] hapus ${path} gagal`, err);
  }
}

const MISSING_HINT =
  `Bucket "${BUCKET}" belum ada. Buka /api/admin/setup?secret=… sekali untuk ` +
  'membuatnya — atau biarkan saja: export besar pertama akan membuatnya sendiri ' +
  'sebelum mengunggah. Selama belum ada, hasil export di atas 3 MB tidak akan sampai.';

/**
 * Untuk /api/health dan /api/admin/diag: bucket-nya sudah dibuat atau belum.
 *
 * Balasan yang tidak ok SELALU membawa isinya, bukan cuma angka status.
 * Versi sebelumnya melaporkan `"storageDetail": "HTTP 400"` dan berhenti di
 * situ — angka yang tidak menuntun ke mana pun, padahal Supabase mengirimkan
 * alasannya lengkap di body yang langsung dibuang.
 */
export async function bucketReady(): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const res = await fetch(`${base()}/bucket/${BUCKET}`, { headers: headers() });
    if (res.ok) return { ok: true, detail: null };

    const body = (await res.text()).slice(0, 300);
    if (meansBucketMissing(res.status, body)) return { ok: false, detail: MISSING_HINT };

    // 401/403 hampir selalu berarti kuncinya salah jenis, bukan bucket-nya
    // bermasalah — dan itu perlu disebut, karena membuka /api/admin/setup
    // seribu kali pun tidak akan menolong.
    return { ok: false, detail: withKeyHint(`HTTP ${res.status} ${body}`) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
}
