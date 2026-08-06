-- 002_security.sql — dedupe update Telegram + kunci akses tabel.
--
-- Jalankan SETELAH 001_init.sql.

-- Retry Telegram membawa update_id yang sama. Primary key di sini yang
-- membuat `/pdf` tidak jalan dua kali saat satu request timeout.
create table if not exists tg_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);

create index if not exists tg_updates_created_at_idx on tg_updates (created_at);

-- Row Level Security: AKTIFKAN, dan JANGAN buat policy apa pun.
--
-- Seluruh akses aplikasi memakai service role key, yang melewati RLS. Tanpa
-- baris di bawah ini, anon key — yang boleh dipegang siapa saja yang membuka
-- panel — bisa membaca seluruh isi bot_users beserta chat ID semua orang.
alter table bot_users     enable row level security;
alter table commands      enable row level security;
alter table machine_state enable row level security;
alter table tg_updates    enable row level security;

-- Pembersih: update lama tidak berguna setelah beberapa hari.
-- Jalankan manual sesekali, atau pasang sebagai cron pg_cron kalau tersedia.
--   delete from tg_updates where created_at < now() - interval '7 days';
