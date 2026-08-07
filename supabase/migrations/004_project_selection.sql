-- Pilihan project per user, untuk satu Revit yang membuka beberapa file.
--
-- Jalankan sekali di Supabase → SQL Editor. Aman diulang.
--
-- KALAU MIGRASI INI BELUM DIJALANKAN, BOT TETAP BEKERJA. Server memeriksa
-- keberadaan kedua kolom ini lebih dulu dan turun ke perilaku lama — semua
-- command tertuju ke dokumen yang sedang aktif di Revit — lalu mengatakannya
-- ke user. Itu disengaja: langkah SQL manual di repo ini pernah terlewat
-- (lihat 003_storage.sql), dan yang terjadi waktu itu bukan pesan kesalahan
-- melainkan berkas yang tidak pernah sampai. Fitur yang mati dengan kalimat
-- jauh lebih murah daripada endpoint yang mati diam-diam.

-- Daftar dokumen yang sedang terbuka di Revit, dikirim add-in tiap heartbeat.
--
-- Disimpan di server, bukan ditanyakan ke Revit saat dibutuhkan: `/project`
-- harus bisa menampilkan tombol pilihannya SEKETIKA. Menanyakannya lewat
-- antrean berarti menunggu satu siklus polling hanya untuk melihat daftar,
-- dan daftar yang butuh empat detik akan berhenti dipakai orang.
alter table machine_state
  add column if not exists open_docs jsonb not null default '[]'::jsonb;

-- Project yang dipilih user. NULL = ikut dokumen yang aktif di Revit, yaitu
-- perilaku sebelum kolom ini ada.
--
-- Disimpan sebagai JUDUL dokumen, bukan id: itu satu-satunya penanda yang
-- bertahan antara satu sesi Revit dan sesi berikutnya. ElementId dan
-- Document.GetHashCode() lahir baru setiap kali file dibuka, jadi pilihan yang
-- disimpan dengannya akan menunjuk entah ke mana setelah Revit di-restart —
-- dan menunjuk ke project yang salah jauh lebih buruk daripada tidak menunjuk
-- sama sekali.
alter table bot_users
  add column if not exists project text;

comment on column machine_state.open_docs is
  'Judul dokumen yang sedang terbuka di Revit, dari heartbeat add-in.';
comment on column bot_users.project is
  'Judul dokumen pilihan user. NULL = ikut dokumen aktif di Revit.';
