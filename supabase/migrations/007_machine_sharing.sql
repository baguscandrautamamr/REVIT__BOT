-- 007_machine_sharing.sql — PC mana yang boleh TERLIHAT oleh user lain.
--
-- Jalankan SETELAH 005_machines.sql. Aman diulang. Opsional: tanpa ini,
-- `/active` hanya menampilkan PC milik user itu sendiri, dan bot tetap bekerja.
--
-- ── Yang diizinkan kolom ini, dan yang TIDAK ──────────────────────────────
--
-- Kolom ini HANYA soal melihat. Ia tidak memberi siapa pun kemampuan mengirim
-- perintah ke PC orang lain — job tetap diarahkan `bot_users.machine_id`, dan
-- hanya admin yang bisa mengubahnya (lihat 006_machine_routing.sql).
--
-- Pembedaan itu disengaja, dan ongkosnya jauh berbeda:
--
--   MELIHAT daftar project aktif → membaca `machines.open_docs` dari database,
--                                  yang sudah disegarkan heartbeat tiap 4 detik.
--                                  Revit orang lain TIDAK disentuh sedetik pun.
--
--   MEMAKAI-nya (/pdf, /count)   → job masuk antrean PC itu, dan satu export
--                                  membekukan Revit-nya 2–5 menit. Pemiliknya
--                                  tidak diberi tahu dan tidak bisa menolak,
--                                  sebab Revit hanya punya satu main thread.
--
-- Jadi yang dibuka di sini adalah yang murah dan bisa dibatalkan; yang mahal
-- tetap lewat admin.
--
-- ── Kenapa default FALSE ──────────────────────────────────────────────────
--
-- Nama berkas model mengungkap nama project, dan nama project sering mengungkap
-- nama klien. Default `true` berarti menjalankan migrasi ini langsung membuka
-- daftar itu ke semua user tanpa satu pun keputusan diambil — dan tidak ada yang
-- akan menyadarinya, sebab tidak ada yang berubah dari sisi mereka yang sudah
-- melihatnya. Default `false` memaksa keputusannya dibuat sadar, satu PC sekali.
alter table machines
  add column if not exists shared boolean not null default false;

comment on column machines.shared is
  'PC ini boleh MUNCUL di /active milik user lain. Tidak memberi izin mengirim perintah ke sana.';
