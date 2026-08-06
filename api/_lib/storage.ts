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
  const res = await fetch(`${base()}/bucket`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      // PRIVAT. Anon key boleh dipegang siapa saja yang membuka panel; ia tidak
      // boleh bisa mengunduh gambar kerja hanya karena menebak nama berkasnya.
      public: false,
      file_size_limit: MAX_FILE_BYTES,
    }),
  });

  if (res.ok) {
    console.log(`[storage] bucket "${BUCKET}" dibuat`);
    return;
  }

  // Sudah ada = tujuan tercapai. Dua proses yang berlomba membuatnya bukan
  // kesalahan, dan Supabase menjawabnya 409 atau 400 tergantung versi.
  const body = await res.text();
  if (res.status === 409 || /exists|duplicate/i.test(body)) return;

  throw new Error(`buat bucket ${BUCKET} gagal: HTTP ${res.status} ${body.slice(0, 300)}`);
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
  if (res.status === 404) {
    await ensureBucket();
    res = await sign(path);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`signed upload URL ${res.status}: ${raw.slice(0, 300)}`);
  }

  // Balasannya { url: "/object/upload/sign/<bucket>/<path>?token=..." }
  const parsed = JSON.parse(raw) as { url?: string };
  if (!parsed.url) throw new Error('signed upload URL: balasan tanpa url');

  const token = new URLSearchParams(parsed.url.split('?')[1] ?? '').get('token') ?? '';
  return { url: `${base()}${parsed.url}`, token };
}

function sign(path: string): Promise<Response> {
  return fetch(`${base()}/object/upload/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
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

/** Untuk /api/health dan /api/admin/diag: bucket-nya sudah dibuat atau belum. */
export async function bucketReady(): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const res = await fetch(`${base()}/bucket/${BUCKET}`, { headers: headers() });
    if (res.ok) return { ok: true, detail: null };
    return {
      ok: false,
      detail:
        res.status === 404
          ? `Bucket "${BUCKET}" belum ada. Buka /api/admin/setup?secret=… sekali untuk ` +
            'membuatnya — atau biarkan saja: export besar pertama akan membuatnya sendiri ' +
            'sebelum mengunggah. Selama belum ada, hasil export di atas 3 MB tidak akan sampai.'
          : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
}
