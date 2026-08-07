-- 006_machine_routing.sql — job diarahkan ke PC pemiliknya.
--
-- Jalankan SETELAH 005_machines.sql. Aman diulang.
--
-- BERKAS INI OPSIONAL, dengan pola yang sama seperti 004 dan 005: server
-- memeriksa keberadaan kedua kolom lebih dulu (`db.routingReady()`) dan turun ke
-- perilaku lama kalau belum ada — satu antrean, dilayani PC mana pun yang
-- mengambil lebih dulu. Alasannya bukan kesantunan: kolom yang belum ada membuat
-- PostgREST menolak SELURUH request, jadi tanpa pemeriksaan itu satu langkah SQL
-- yang terlewat mematikan /claim, dan bersamanya seluruh bot.
--
-- ── Apa yang berubah setelah ini dijalankan ────────────────────────────────
--
-- Sebelum:  satu antrean → PC mana pun yang polling lebih dulu mengambilnya.
--           Dengan dua PC, PC user 2 bisa mengerjakan job user 1 — dan kalau
--           judul modelnya kebetulan sama, penjagaan `expectedDocTitle` di add-in
--           pun lolos. Hasilnya benar-benar terkirim, dari model yang salah.
--
-- Sesudah:  setiap job membawa `machine_id`, dan /claim hanya mengambil job yang
--           dialamatkan ke PC pemanggil.
--
-- ── Kenapa tidak butuh `for update skip locked` ────────────────────────────
--
-- Komentar di `db.claimNextCommand` menyebut fungsi Postgres itu sebagai jalan
-- untuk PC kedua. Untuk topologi INI ternyata tidak perlu: satu user dipasangkan
-- ke tepat satu PC, dan setiap PC hanya mengklaim job yang dialamatkan ke
-- dirinya — jadi dua PC tidak akan pernah memperebutkan baris yang sama. Trik
-- "PATCH dengan filter status=pending" yang sudah ada tetap cukup, dan ia masih
-- berguna untuk satu kasus yang tersisa: satu PC yang menjalankan dua sesi Revit.

-- PC yang melayani user ini. NULL punya arti yang berbeda tergantung berapa PC
-- yang terdaftar, dan itu disengaja supaya tidak ada langkah yang menjadi jurang:
--
--   0 baris `machines`  → perilaku lama sepenuhnya (tidak ada yang diarahkan).
--   1 baris             → semua job ke PC itu. Tidak ada yang bisa salah pilih,
--                         jadi penugasan per user belum perlu diisi sama sekali.
--   ≥2 baris            → user tanpa penugasan DITOLAK dengan kalimat beserta
--                         daftar PC yang ada. Menebak salah satunya berarti
--                         mengerjakan model orang lain dan mengirimkannya sebagai
--                         hasil yang sah.
alter table bot_users
  add column if not exists machine_id uuid references machines(id);

-- PC tujuan job, DIBEKUKAN saat job dibuat — bukan dibaca ulang saat diklaim.
--
-- Alasannya sama seperti kolom `lang` di 001: kalau admin memindahkan user ke PC
-- lain selagi job berjalan, job yang sudah mengantre tetap dikerjakan PC yang
-- dimaksud waktu ia dibuat. Membacanya ulang saat klaim berarti satu perubahan
-- penugasan bisa memindahkan pekerjaan yang sedang berlangsung ke model lain.
alter table commands
  add column if not exists machine_id uuid references machines(id);

-- Index untuk pertanyaan yang dijalankan tiap 4 detik per PC:
-- "job pending paling lama yang dialamatkan ke saya (atau belum dialamatkan)".
create index if not exists commands_claim_idx on commands (status, machine_id, created_at);

comment on column bot_users.machine_id is
  'PC Revit yang melayani user ini. NULL = ikut aturan di 006_machine_routing.sql.';
comment on column commands.machine_id is
  'PC tujuan job, dibekukan saat dibuat. NULL = job dari era sebelum routing ada.';
