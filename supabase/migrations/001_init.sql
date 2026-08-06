-- 001_init.sql — skema dasar Revit Telegram Bridge.
-- Dua tabel inti + preferensi bahasa/tema per user.

create table bot_users (
  chat_id    bigint primary key,
  name       text not null,
  role       text not null default 'viewer' check (role in ('viewer','admin')),
  is_active  boolean not null default true,

  -- Preferensi tampilan per user -----------------------------------------
  -- 'auto' = ikuti `message.from.language_code` yang dikirim Telegram tiap update.
  lang       text not null default 'auto'  check (lang  in ('auto','id','en')),
  -- 'auto' = ikuti tema klien (Telegram colorScheme / prefers-color-scheme).
  theme      text not null default 'auto'  check (theme in ('auto','light','dark')),

  created_at timestamptz not null default now()
);

create table commands (
  id            uuid primary key default gen_random_uuid(),
  chat_id       bigint not null references bot_users(chat_id),
  tg_message_id bigint,                  -- untuk edit pesan "⏳", bukan spam

  command       text not null,           -- 'pdf', 'count', 'status'
  payload       jsonb not null default '{}',

  -- Bahasa dibekukan saat command dibuat, bukan dibaca ulang saat report.
  -- Kalau user ganti bahasa selagi job jalan, balasannya tetap konsisten
  -- dengan pesan "⏳" yang sedang di-edit.
  lang          text not null default 'id' check (lang in ('id','en')),

  status        text not null default 'pending'
                check (status in ('pending','running','done','failed','expired','cancelled')),
  doc_title     text,                    -- diisi add-in saat eksekusi (audit)
  result        jsonb,
  error         text,

  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '10 minutes',
  created_at    timestamptz not null default now()
);

create index on commands (status, created_at);
create index on commands (chat_id, created_at desc);

-- Heartbeat + kill switch. Satu baris saja selama masih satu PC Revit.
create table machine_state (
  id            int primary key default 1 check (id = 1),
  last_seen_at  timestamptz,
  active_doc    text,
  revit_version text,
  addin_version text,
  is_paused     boolean not null default false,
  bot_enabled   boolean not null default true
);

insert into machine_state (id) values (1) on conflict do nothing;
