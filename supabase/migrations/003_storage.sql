-- 003_storage.sql — tempat singgah berkas hasil export.
--
-- BERKAS INI OPSIONAL. Server membuat bucket-nya sendiri: `/api/admin/setup`
-- membuatnya saat dibuka, dan kalau belum ada juga, export besar PERTAMA akan
-- membuatnya sebelum mengunggah (lihat `ensureBucket` di api/_lib/storage.ts).
-- Jalankan berkas ini hanya kalau kamu memang ingin menyiapkannya lebih dulu.
--
-- ── Kenapa bucket ini ada ────────────────────────────────────────────────
-- Hasil /pdf tidak pernah sampai ke Telegram, dan bukan karena Revit. Add-in
-- mengirim PDF-nya sebagai base64 di dalam body JSON ke /api/machine/report,
-- dan body request ke Serverless Function Vercel dibatasi 4,5 MB oleh
-- platformnya — batas keras, tidak bisa dinaikkan lewat konfigurasi apa pun
-- (`bodyParser.sizeLimit` di kode hanya mengatur parser, bukan platformnya).
-- Satu sheet A1 dengan RasterQuality High jauh melewati itu: 4,5 MB body ≈
-- 3,3 MB PDF setelah pembengkakan base64 sepertiga.
--
-- Requestnya ditolak 413 sebelum satu baris handler pun jalan, add-in hanya
-- mencatatnya sebagai warning, dan barisnya tetap `running` selamanya — persis
-- yang terlihat: "1 Running" selama 13 menit untuk satu PDF, sementara /levels
-- yang dikirim sesudahnya tetap dijawab dalam sedetik.
--
-- Sekarang add-in mengunggah berkasnya LANGSUNG ke bucket ini memakai signed
-- upload URL, tanpa melewati Vercel sama sekali, lalu /report cukup menyebut
-- path-nya. Server yang mengambilnya dan meneruskannya ke Telegram — arah itu
-- tidak kena batas 4,5 MB, karena yang dibatasi hanya body request masuk.

insert into storage.buckets (id, name, public, file_size_limit)
values ('job-files', 'job-files', false, 52428800)   -- 50 MB = batas upload bot Telegram
on conflict (id) do update set
  public = false,
  file_size_limit = 52428800;

-- ── JANGAN tambahkan baris ini ───────────────────────────────────────────
--   alter table storage.objects enable row level security;
--
-- Versi pertama berkas ini memuatnya, dan SQL Editor Supabase menjawab:
--   ERROR: 42501: must be owner of table objects
-- `storage.objects` dimiliki `supabase_storage_admin`, sementara SQL Editor
-- berjalan sebagai `postgres`. Yang membuatnya mahal: SQL Editor menjalankan
-- seluruh skrip dalam SATU transaksi, jadi `insert` bucket di atas ikut
-- di-rollback — orang mengira migrasinya sudah jalan padahal tidak ada yang
-- terbentuk.
--
-- Barisnya juga memang tidak diperlukan. Supabase sudah menyalakan RLS pada
-- storage.objects sejak awal, dan bucket ini dibuat PRIVAT tanpa satu pun
-- policy — jadi anon key, yang boleh dipegang siapa saja yang membuka panel,
-- tidak bisa menyentuh isinya. Seluruh akses memakai service role key di
-- server, yang melewati RLS.

-- Pembersih. Berkas di sini hanya persinggahan: begitu terkirim ke Telegram,
-- server menghapusnya. Yang tersisa adalah sisa job yang gagal di tengah, dan
-- itu tidak boleh menumpuk sampai memakan kuota storage.
--
-- Jalankan manual sesekali, atau pasang sebagai cron pg_cron kalau tersedia:
--   delete from storage.objects
--   where bucket_id = 'job-files' and created_at < now() - interval '1 day';
