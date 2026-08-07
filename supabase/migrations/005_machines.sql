-- 005_machines.sql — daftar PC Revit sebagai DATA, bukan environment variable.
--
-- Jalankan sekali di Supabase → SQL Editor. Aman diulang.
--
-- BERKAS INI OPSIONAL. Tanpa dijalankan, bot tetap bekerja persis seperti
-- sebelumnya: `machineauth` memeriksa keberadaan tabel ini lebih dulu, dan kalau
-- belum ada ia jatuh ke `MACHINE_TOKEN` di environment — jalur satu-satunya yang
-- dipakai sampai sekarang. Yang mati hanyalah tombol "Tambah PC" di panel, dan ia
-- mati dengan kalimat. Pola yang sama dipakai 004_project_selection.sql, dan
-- alasannya sama: langkah SQL manual di repo ini pernah terlewat, dan yang terjadi
-- bukan pesan kesalahan melainkan berkas yang tidak pernah sampai.
--
-- ── Kenapa tabel, bukan env var ────────────────────────────────────────────
-- Satu `MACHINE_TOKEN` di Vercel cukup selama hanya ada satu PC Revit. Untuk PC
-- kedua dan ketiga, jalur env memaksa tiga hal yang semuanya buruk:
--
--   1. Mengubah env var butuh REDEPLOY. Menambah PC jadi punya risiko deploy.
--   2. `MACHINE_TOKEN_1/_2/_3` berarti kode harus tahu ada berapa. Menambah PC
--      jadi berarti mengubah kode.
--   3. Mencabut satu PC = hapus env + redeploy. Sampai redeploy-nya jalan, PC
--      yang sudah dicabut masih hidup.
--
-- Sebagai baris tabel, ketiganya hilang: admin menekan tombol di panel, dan
-- berlakunya seketika. Batasnya jelas — env untuk KONFIGURASI (satu nilai, jarang
-- berubah), tabel untuk DATA (bertambah, berkurang, dicabut). Daftar PC adalah
-- data, sama seperti `bot_users`.
--
-- ⚠ PENTING — TABEL INI BELUM MENGARAHKAN JOB.
-- Ia membuat BEBERAPA token diterima, tapi `claimNextCommand()` masih mengambil
-- job pending mana pun tanpa melihat siapa yang meminta. Jadi memasang PC KEDUA
-- yang sungguhan sebelum routing per-PC ada akan membuat PC itu MENCURI job milik
-- user PC pertama. Sampai routing itu jadi, tabel ini hanya untuk: mengganti
-- token PC yang sudah ada tanpa redeploy, dan mencabutnya satu per satu.

create table if not exists machines (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,

  -- SHA-256 hex dari token, BUKAN tokennya.
  --
  -- Kalau isi database bocor, hash tidak bisa dipakai untuk memanggil /claim.
  -- Pencariannya tetap satu query — server meng-hash token yang datang lalu
  -- mencari hash-nya lewat index unique di bawah.
  --
  -- Konsekuensinya harus disebut ke admin di panel: token TIDAK BISA dilihat
  -- lagi setelah ditampilkan sekali. Yang hilang diganti, bukan dipulihkan.
  token_hash    text not null unique,

  is_active     boolean not null default true,

  -- Heartbeat per PC. Diisi /api/machine/claim setiap 4 detik, dan yang dibaca
  -- panel untuk menampilkan PC mana yang hidup.
  --
  -- `machine_state` TIDAK digantikan olehnya: baris tunggal itu tetap sumber
  -- untuk /status, /project, dan penyapu selama routing per-PC belum ada. Dua
  -- tempat sementara, dengan sengaja — memindahkan sepuluh pemanggil
  -- `getMachine()` sekaligus adalah perubahan yang berbeda dari yang ini.
  last_seen_at  timestamptz,
  active_doc    text,
  open_docs     jsonb not null default '[]'::jsonb,
  revit_version text,
  addin_version text,
  is_paused     boolean not null default false,

  created_at    timestamptz not null default now()
);

-- Sama seperti 002_security.sql: NYALAKAN, dan JANGAN buat policy apa pun.
-- Seluruh akses memakai service role key yang melewati RLS. Tanpa baris ini,
-- anon key — yang boleh dipegang siapa saja yang membuka panel — bisa membaca
-- seluruh isi tabel ini, termasuk kolom hash-nya.
alter table machines enable row level security;

comment on table machines is
  'PC Revit yang boleh memanggil /api/machine/*. Token disimpan sebagai SHA-256.';
comment on column machines.token_hash is
  'SHA-256 hex dari machine token. Tokennya sendiri tidak pernah disimpan.';
