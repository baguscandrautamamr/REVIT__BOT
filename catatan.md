# CATATAN — Cetak Biru "Desktop CAD ↔ Chat Bot"

Struktur yang bisa dipakai ulang untuk membuat bot serupa: **satu aplikasi
desktop yang tidak punya IP publik, dikendalikan dari chat**. Repo ini
kebetulan Revit + Telegram, tapi bentuknya tidak khusus keduanya.

> **Bedanya dengan dokumen lain di repo ini.**
>
> | Dokumen | Isi |
> |---|---|
> | **catatan.md** (ini) | Cetak biru untuk **project berikutnya**. Struktur, kontrak, jebakan, urutan bangun. |
> | [docs/CATATAN-ARSITEKTUR.md](./docs/CATATAN-ARSITEKTUR.md) | Catatan desain **asli project ini**, dipertahankan apa adanya sebagai rujukan keputusan. |
> | [README.md](./README.md) | Cara memakai dan men-deploy project ini. |
> | [docs/SETUP-LANGKAH.md](./docs/SETUP-LANGKAH.md) | Langkah setup satu per satu. |
>
> Kalau kamu sedang **menyalin repo ini untuk bot kedua**, mulai dari
> [§11 Checklist salin-project](#11-checklist-salin-project).

---

## 1. Kapan struktur ini cocok

Struktur ini lahir dari tiga batasan. Selama ketiganya berlaku, bentuknya
akan seperti ini — bukan karena selera, tapi karena tidak ada pilihan lain.

| # | Batasan | Konsekuensi struktural |
|---|---|---|
| 1 | **PC tidak punya IP publik.** Ada di balik NAT kantor/rumah. | Server tidak bisa memanggil masuk. Semua komunikasi harus **outbound dari PC** → pola *polling/claim*, bukan webhook ke PC. |
| 2 | **API aplikasi hanya hidup di dalam prosesnya.** Revit API cuma ada di `Revit.exe`. | Aplikasinya **wajib terbuka**. Command yang datang saat tutup harus mengantre + kedaluwarsa, bukan gagal. |
| 3 | **API hanya boleh dipanggil dari main thread.** | Polling di background thread, eksekusi dipindah ke main thread lewat mekanisme resmi aplikasinya (`ExternalEvent` di Revit). |

Cek dulu ketiganya di project barumu:

- Kalau **(1) tidak berlaku** (aplikasinya di server yang bisa dijangkau) →
  buang seluruh lapisan `claim` + `machine_state`, panggil langsung. Jauh lebih
  sederhana.
- Kalau **(2) tidak berlaku** (ada mode headless/CLI, mis. AutoCAD Core
  Console, LibreOffice `--headless`, Blender `-b`) → server bisa menjalankan
  prosesnya sendiri saat dibutuhkan. Buang antrean+heartbeat, ganti jadi
  spawn process.
- Kalau **(3) tidak berlaku** → buang `ExternalEvent`, eksekusi langsung di
  thread polling. Tapi **jangan berasumsi**: sebagian besar API CAD/Office
  in-process bersifat single-threaded apartment.

**Contoh yang cocok:** Revit, AutoCAD (in-process .NET), SketchUp,
Rhino/Grasshopper, Navisworks, Excel/Word via COM add-in, Photoshop UXP,
software mesin/PLC berlisensi dongle.

---

## 2. Bentuk umum: empat lapisan

```
┌────────────┐   command      ┌──────────────┐   antrean    ┌────────────┐
│  KLIEN     │ ─────────────► │  SERVER      │ ───────────► │  DATABASE  │
│  chat      │ ◄───────────── │  serverless  │ ◄─────────── │  + storage │
└────────────┘   hasil        └──────────────┘              └─────┬──────┘
                                     ▲                            │
                                     │ claim (tiap 4 detik)       │
                                     │ report (saat selesai)      │
                              ┌──────┴───────────────────────────▼┐
                              │  AGEN DESKTOP (add-in)            │
                              │  background thread → main thread  │
                              └───────────────────────────────────┘
```

Peran tiap lapisan — **jangan dicampur**, ini yang bikin project tetap bisa
dirawat:

| Lapisan | Tanggung jawab | TIDAK boleh |
|---|---|---|
| **Klien** (Telegram, + panel web opsional) | Tampilan, tombol, teks | Menyimpan aturan (role, batas). Menu chat cuma kosmetik — orang tetap bisa mengetik command manual |
| **Server** (serverless function) | Validasi user, cek role + batas, insert antrean, kirim hasil ke klien, i18n | Kerja berat. Handler harus selesai dalam detik |
| **Database** | Antrean, user, status mesin, kill switch | Logika bisnis (kecuali klaim job yang butuh atomicity) |
| **Agen desktop** | Polling, eksekusi API aplikasi, kirim hasil | Menegakkan izin. Agen percaya server — server yang menyaring |

Aturan yang paling sering dilanggar: **batas dan role ditegakkan di server**,
bukan di agen dan bukan dengan menyembunyikan tombol.
Lihat `api/_lib/limits.ts`.

Satu pengecualian yang wajar, dan bentuknya penting: batas yang **tidak bisa
diketahui server** dikirim server sebagai angka di dalam payload, lalu
ditegakkan agen. Contoh di repo ini: `maxSheets` untuk permintaan
per-grup — hanya add-in yang tahu satu grup berisi berapa sheet. Server
tetap pemilik aturannya; agen cuma eksekutor.

---

## 3. Struktur folder

Salin ini apa adanya. Anotasi menjelaskan **kenapa** tiap bagian ada.

```
project/
├─ api/                          ← server (Vercel serverless)
│  ├─ package.json                 ⚠ WAJIB. Lihat §9 jebakan #1
│  ├─ tsconfig.json                ⚠ output CommonJS. Lihat §9 jebakan #1
│  ├─ telegram/
│  │  └─ webhook.ts                satu-satunya pintu masuk dari chat
│  ├─ machine/
│  │  ├─ claim.ts                  agen ambil job — merangkap heartbeat
│  │  ├─ report.ts                 agen lapor hasil
│  │  └─ upload-url.ts             signed URL untuk berkas besar
│  ├─ admin/
│  │  ├─ setup.ts                  pasang webhook + menu command sekali klik
│  │  └─ diag.ts                   diagnosa: env kurang apa, DB nyambung?
│  ├─ panel/                       endpoint panel web (opsional)
│  ├─ health.ts                    tanpa auth, buat cek deploy hidup
│  └─ _lib/                        ← semua logika bersama, TANPA endpoint
│     ├─ env.ts                    baca env di satu tempat, jangan throw saat import
│     ├─ db.ts                     satu-satunya yang tahu bentuk tabel
│     ├─ commands.ts               ★ SUMBER TUNGGAL daftar command
│     ├─ limits.ts                 role, kuota, cooldown, ambang online
│     ├─ telegram.ts               kirim/edit pesan, escaping, batas panjang
│     ├─ reply.ts                  penyusun teks balasan
│     ├─ storage.ts                jalur berkas besar
│     ├─ sweep.ts                  tutup job kedaluwarsa/terlantar
│     ├─ machineauth.ts            bearer token agen, timing-safe
│     ├─ projects.ts               pilih target kalau aplikasi buka >1 dokumen
│     ├─ preferences.ts            bahasa & tema per user
│     └─ i18n/{index,id,en,types}.ts
│
├─ addin/                        ← agen desktop (C# / .NET)
│  ├─ App.cs                       IExternalApplication: nyala di OnStartup
│  ├─ Polling/QueueWorker.cs       ★ background loop — NOL panggilan API aplikasi
│  ├─ Events/CommandHandler.cs     ★ IExternalEventHandler — main thread
│  ├─ Services/
│  │  ├─ BridgeClient.cs           HttpClient static + pilih jalur berkas
│  │  ├─ TokenStore.cs             token di %APPDATA%, terenkripsi DPAPI
│  │  ├─ DialogSuppressor.cs       auto-dismiss dialog saat job jalan
│  │  └─ Log.cs                    log berkas — agen tidak punya konsol
│  ├─ Commands/
│  │  ├─ IBotCommand.cs            ★ antarmuka: 1 command = 1 berkas
│  │  ├─ <Xxx>Command.cs           satu per command
│  │  └─ <helper>.cs               resolver level/view/sheet, layout, dsb.
│  ├─ Project.csproj               ⚠ dua jalur referensi API. Lihat §9 jebakan #6
│  ├─ Project.addin                manifest — GUID harus unik per bot
│  └─ set-token.ps1                pasang token sekali di PC
│
├─ supabase/migrations/*.sql     ← skema, dijalankan manual, aman diulang
├─ web/                          ← panel (Telegram Mini App / halaman statis)
├─ scripts/                      ← ★ penjaga otomatis. Lihat §10
│  ├─ check-runtime.ts             format modul fungsi benar-benar termuat?
│  ├─ check-commands.ts            daftar command server ↔ panel sinkron?
│  ├─ check-i18n.ts                key terjemahan lengkap?
│  ├─ check-addin.ts               sumber C# waras (tanpa .NET SDK)?
│  ├─ simulate-job.ts              ★ rantai hasil utuh, pakai handler ASLI
│  └─ set-commands.ts              pasang menu command ke chat
├─ .github/workflows/{check,addin}.yml
├─ docs/
├─ .env.example                  ← nama env + alasannya, TANPA nilai
└─ vercel.json
```

Yang ditandai ★ adalah tulang punggung. Kalau salah satu hilang, strukturnya
berubah sifat: tanpa `commands.ts` daftar command tersebar di 4 tempat; tanpa
`IBotCommand` menambah command jadi menyunting kelas besar; tanpa
`simulate-job.ts` kegagalan senyap tidak pernah tertangkap.

---

## 4. Tiga kontrak yang membuat "tambah command = 2 berkas"

Ini inti kemudahan perawatannya. Menambah kemampuan baru = **satu entri di
`commands.ts`** + **satu berkas di `Commands/`**. Tidak ada tempat ketiga.

### 4.1 Spesifikasi command (server, sumber tunggal)

`api/_lib/commands.ts`:

```ts
export interface CommandSpec {
  name: string;                    // a-z 0-9 _ , ≤32 char (aturan Telegram)
  role: 'viewer' | 'admin';
  section: 'info'|'query'|'export'|'modify'|'admin';
  aliases?: Partial<Record<Locale, string[]>>;  // /lantai == /levels
  usage?: Partial<Record<Locale, string>>;
  inMenu: boolean;                 // muncul di menu "/" chat
  confirm?: boolean;               // butuh konfirmasi dua langkah
  addin?: boolean;                 // sudah ada implementasinya di agen
}
```

Dipakai oleh webhook (routing + role), `/help`, `scripts/set-commands.ts`,
dan penjaga `check-commands.ts`. Satu daftar, empat pemakai.

`addin: false` penting: command yang butuh desktop tapi belum
diimplementasi **ditolak di server**, sebelum masuk antrean. Kalau tidak, ia
menempuh seluruh perjalanan hanya untuk dijawab "belum ada" — dan kalau PC
mati, menggantung 10 menit dulu.

### 4.2 Job (server → agen)

```jsonc
{
  "id": "uuid",
  "command": "pdf",
  "payload": { "views": ["LP-01"], "maxSheets": 10 },
  "expectedDocTitle": "PRJ-B"        // ← penjaga target, §5 pola #4
}
```

Payload **selalu** `jsonb` bebas bentuk. Jangan bikin kolom per command —
kolom baru = migrasi per fitur.

### 4.3 Hasil (agen → server)

```csharp
public interface IBotCommand {
    string Name { get; }                                  // == commands.ts
    ExecResult Run(Document doc, JsonElement payload);
}

public sealed class ExecResult {
    public bool Ok { get; init; }
    public string? Text { get; init; }
    public string? Error { get; init; }
    public byte[]? FileBytes { get; init; }   // MENTAH, bukan base64 — §9 jebakan #2
    public string? FileName { get; init; }
}
```

`FileBytes` mentah bukan detail gaya: yang memilih jalur pengiriman
(inline vs storage) adalah `BridgeClient`, dan pilihan itu butuh ukuran
aslinya, bukan yang sudah dikembungkan base64 sepertiga.

---

## 5. Delapan pola agen yang wajib diikutkan

Ini pencegah kerusakan, bukan optimasi. Semua sudah pernah gagal sungguhan.

| # | Pola | Tanpa itu |
|---|---|---|
| 1 | **`ExternalEvent` untuk semua akses API aplikasi** | Crash acak, kadang setelah berjam-jam, dan stack trace-nya **tidak** menunjuk ke penyebabnya |
| 2 | **`HttpClient` static, satu per proses** | Socket exhaustion: tiap koneksi tertinggal di `TIME_WAIT`, polling 4 detik menghabiskan port dalam hitungan jam. Gejalanya "bot tiba-tiba mati" |
| 3 | **`try/catch` di DALAM loop polling** | Wifi putus 3 detik → worker mati diam-diam. Aplikasi tetap terbuka, tidak ada yang tahu sampai ada yang mengeluh |
| 4 | **Guard target sebelum eksekusi** (`doc.Title == expectedDocTitle`) | Dapat PDF sheet yang benar dari **project yang salah**, dan tidak akan sadar |
| 5 | **`Raise()` di SETIAP siklus, bukan hanya saat ada job** | Nilai yang cuma bisa dibaca dari main thread (versi app, judul dokumen) tidak pernah terisi sampai job pertama, lalu **membeku** di nilai lama |
| 6 | **`busy` mencakup antrean internal, bukan cuma "sedang jalan"** | Ada jendela nyata antara job diterima dan main thread jalan. Di jendela itu server menyimpulkan job terlantar → menutupnya tepat sebelum dikerjakan |
| 7 | **`Stop()` tidak memblokir, dispose ditunda sampai loop keluar** | `ObjectDisposedException` di thread latar tepat saat aplikasi ditutup — mudah sekali disalahartikan sebagai "add-in bikin crash saat keluar" |
| 8 | **Timeout upload terpisah & jauh lebih longgar** | 30 detik cukup untuk JSON, tidak untuk berkas 20 MB. Upload dibatalkan di tengah → `TaskCanceledException` masuk log, job tetap `running`, di chat cuma "⏳" abadi |

Tambahan yang lebih murah tapi tetap perlu:

- **Log ke berkas** (`%APPDATA%`, dipotong di 5 MB). Agen tidak punya konsol,
  dan dialog di dalam loop polling akan membekukan aplikasinya.
- **Token di `%APPDATA%` terenkripsi DPAPI**, jangan di dalam DLL. String di
  DLL terbaca dengan editor teks biasa; DPAPI mengikat cipher ke akun Windows.
- **Penampung dialog aktif hanya selama job**. Di luar job, aplikasinya tetap
  milik orang yang duduk di depannya.
- **`OnStartup` tidak boleh melempar exception.** Aplikasi akan menampilkan
  dialog dan menonaktifkan add-in-nya. Tangkap, log, `return Succeeded`.

---

## 6. Skema minimum

Empat tabel. Jangan lebih sampai pemicunya muncul ([§12](#12-kapan-naik-level)).

```sql
-- Siapa yang boleh
create table bot_users (
  chat_id    bigint primary key,
  name       text not null,
  role       text not null default 'viewer' check (role in ('viewer','admin')),
  is_active  boolean not null default true,
  lang       text not null default 'auto' check (lang  in ('auto','id','en')),
  theme      text not null default 'auto' check (theme in ('auto','light','dark')),
  created_at timestamptz not null default now()
);

-- Antrean
create table commands (
  id            uuid primary key default gen_random_uuid(),
  chat_id       bigint not null references bot_users(chat_id),
  tg_message_id bigint,          -- EDIT pesan "⏳", jangan kirim pesan baru
  command       text not null,
  payload       jsonb not null default '{}',
  lang          text not null default 'id',   -- dibekukan saat dibuat
  status        text not null default 'pending'
                check (status in ('pending','running','done','failed','expired','cancelled')),
  doc_title     text,            -- diisi agen saat eksekusi (audit)
  result        jsonb,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz not null default now() + interval '10 minutes',
  created_at    timestamptz not null default now()
);
create index on commands (status, created_at);
create index on commands (chat_id, created_at desc);

-- Heartbeat + kill switch. Satu baris selama masih satu PC.
create table machine_state (
  id            int primary key default 1 check (id = 1),
  last_seen_at  timestamptz,
  active_doc    text,
  open_docs     jsonb not null default '[]'::jsonb,
  app_version   text,          -- di repo ini: revit_version
  agent_version text,          -- di repo ini: addin_version
  is_paused     boolean not null default false,
  bot_enabled   boolean not null default true
);
insert into machine_state (id) values (1) on conflict do nothing;

-- Dedupe retry platform chat. Primary key di sini yang membuat `/pdf`
-- tidak jalan dua kali saat satu request timeout.
create table tg_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);
create index on tg_updates (created_at);

-- ★ RLS: NYALAKAN, dan JANGAN buat policy apa pun.
-- Seluruh akses aplikasi memakai service role key, yang melewati RLS. Tanpa
-- ini, anon key — yang boleh dipegang siapa saja yang membuka panel — bisa
-- membaca seluruh bot_users beserta chat ID semua orang.
alter table bot_users     enable row level security;
alter table commands      enable row level security;
alter table machine_state enable row level security;
alter table tg_updates    enable row level security;
```

Empat keputusan yang tampak sepele tapi menentukan:

- **`tg_message_id` disimpan** → hasil meng-*edit* pesan "⏳". Tanpa ini chat
  jadi tiga pesan per command.
- **`lang` dibekukan di baris `commands`**, tidak dibaca ulang saat report.
  User ganti bahasa selagi job jalan → balasannya tetap konsisten dengan
  pesan yang sedang di-edit.
- **`expires_at` punya nilai default**, bukan diisi kode. Command basi tidak
  boleh tiba-tiba jalan setelah aplikasi dibuka lagi besok pagi.
- **`bot_enabled`** = kill switch jarak jauh. Ubah satu baris di dashboard DB,
  webhook langsung menolak semua. Lebih cepat daripada remote ke laptop.

**Target disimpan sebagai judul/nama dokumen, bukan id internal.** ElementId
dan hash objek lahir baru setiap kali file dibuka — pilihan yang disimpan
dengannya akan menunjuk entah ke mana setelah restart, dan menunjuk ke
project yang salah jauh lebih buruk daripada tidak menunjuk sama sekali.

---

## 7. Endpoint minimum

| Endpoint | Pemanggil | Aturan mengikat |
|---|---|---|
| `POST /api/telegram/webhook` | Chat platform | Verifikasi header rahasia dulu. **SELALU balas 200**, bahkan saat gagal — non-2xx = platform retry = `/pdf` jalan dua kali. Dedupe `update_id`. Tidak ada kerja berat |
| `POST /api/machine/claim` | Agen, tiap 4 detik | Merangkap **heartbeat**: tetap dipanggil walau idle dan walau `busy`. Tidak perlu endpoint heartbeat terpisah |
| `POST /api/machine/report` | Agen, saat selesai | Terima hasil, kirim ke chat, tutup baris. Idempoten — laporan ganda tidak boleh kirim berkas dua kali |
| `POST /api/machine/upload-url` | Agen, untuk berkas besar | Signed URL. Berkas **tidak** lewat serverless |
| `GET /api/admin/setup?secret=…` | Manusia, sekali | Pasang webhook + menu command. Tanpa ini command bekerja tapi tak muncul di menu "/" |
| `GET /api/admin/diag` | Manusia, saat bermasalah | Env mana yang kurang, DB nyambung, webhook terpasang. **Nama saja, nilainya jangan pernah keluar** |
| `GET /api/health` | Monitor | Tanpa auth, cek deploy hidup |

**Kenapa `claim` merangkap heartbeat.** Server tahu PC hidup karena claim
tetap masuk. Dan ini bukan penghematan: berhenti memanggil claim selama job
berjalan membuat `last_seen_at` basi — ambang online cuma 30 detik, jadi satu
export satu menit sudah cukup untuk membuat `/status` melapor "PC offline"
tepat ketika PC-nya justru sedang bekerja.

### Penyapu (`sweep`)

Dipanggil dari `claim`, bukan cron. Tiga ambang, dan ketiganya beda sifat:

| Ambang | Kapan dipakai | Contoh nilai |
|---|---|---|
| `STUCK_AFTER_MS` | Heartbeat **berhenti** — aplikasi ditutup, PC mati | 15 menit |
| `ORPHAN_AFTER_MS` | Heartbeat masuk tapi agen bilang **tidak** memegang job itu → hilang bersama restart agen | 2 menit |
| `MAX_RUNTIME_MS` | Jaring terakhir. Agen bilang masih kerja, tapi satu dialog tak tertangkap bisa menggantung main thread selamanya | 2 jam |

Timer saja tidak cukup — itu akan menutup job yang masih dikerjakan dengan
alasan "aplikasi ditutup". Sinyal `busy` dari agen yang membedakan
export 25 sheet yang memang lama dari job yang mati bersama prosesnya.

**Menutup baris di DB bukan akhir pekerjaan penyapu.** Pemiliknya harus
diberi tahu di chat — pesan "⏳" yang tidak pernah berubah adalah kegagalan
yang sama buruknya dengan error.

---

## 8. Kegagalan senyap: musuh utama

Pola kerusakan yang paling mahal di arsitektur ini **tidak menghasilkan error
sama sekali**. Semua lampu hijau, dan hasilnya hilang.

Contoh nyata dari repo ini:

| Kerusakan | Yang terlihat | Kenapa lolos |
|---|---|---|
| Body request >4,5 MB ditolak platform | "⏳" abadi | 413 sebelum handler jalan. Agen catat warning, baris tetap `running` |
| Key terjemahan hilang | User EN lihat campuran dua bahasa | `t()` diam-diam fallback ke bahasa default |
| Daftar command panel menyimpang | Panel tampil lebih sedikit tombol | Tidak ada yang error. Tidak ada yang sadar |
| Format modul fungsi salah | `FUNCTION_INVOCATION_FAILED` | `tsc` hijau. Jejaknya cuma di log platform |
| Kolom migrasi belum ada | Heartbeat mati total, **bukan** cuma fitur baru | PostgREST menolak SELURUH PATCH kalau satu kolom tak dikenal |
| Menu `setMyCommands` tidak dipasang ulang | Command bekerja kalau diketik, tak muncul di "/" | Tidak ada error di mana pun |

Dua kebiasaan yang menjawab seluruh kelas masalah ini:

**a. Fitur yang mati harus mati dengan kalimat.**
Migrasi opsional? Periksa dulu keberadaan kolomnya, turun ke perilaku lama,
lalu **katakan** ke user. Contoh: `db.projectSelectionReady()` di
`api/machine/claim.ts`. Fitur yang mati dengan kalimat jauh lebih murah
daripada endpoint yang mati diam-diam.

**b. Kegagalan yang senyap wajib punya penjaga di CI.** Lihat §10.

---

## 9. Jebakan platform yang sudah dibayar

Setiap poin di sini pernah memakan waktu berjam-jam. Baca sebelum menulis
kode, bukan sesudah.

### 1. Format modul fungsi serverless — `api/package.json` WAJIB ada

`@vercel/node` tidak mem-bundle. Ia meng-compile tiap `.ts` dengan tsconfig
**terdekat**, lalu Node menentukan format dari `package.json` **terdekat**.
Dua berkas, dua keputusan, dan keduanya harus sepakat:

```
emit ESM + "type":"commonjs" → SyntaxError: Cannot use import statement…
emit CJS + "type":"module"   → ReferenceError: exports is not defined
emit ESM + "type":"module"   → ERR_MODULE_NOT_FOUND  (import relatif tanpa ekstensi)
```

Ketiganya keluar sebagai `FUNCTION_INVOCATION_FAILED` yang identik.
**Solusi:** root boleh `"type":"module"` (supaya `scripts/` bisa top-level
await), tapi `api/package.json` berisi `{"type":"commonjs"}` dan
`api/tsconfig.json` meng-emit CommonJS. Jangan pakai top-level `await` atau
`import.meta` di mana pun dalam `api/`.

### 2. Batas ukuran, berlapis

| Batas | Nilai | Sifat |
|---|---|---|
| Body request serverless (Vercel) | **4,5 MB** | Keras, tidak bisa dinaikkan dari kode |
| Upload bot Telegram | **50 MB** | Di atas ini: kirim signed URL |
| Base64 | **+33%** | 3 MB berkas ≈ 4 MB body |

Jalur berkas besar, dan perhatikan arahnya:

```
agen → minta signed upload URL   (JSON kecil, lewat serverless)
agen → PUT berkas ke storage     (LANGSUNG, TIDAK lewat serverless)
agen → /report sebut path saja   (JSON kecil, lewat serverless)
server → unduh dari storage, kirim chat, hapus
```

Arah **unduh** tidak dibatasi 4,5 MB — yang dibatasi hanya body yang *masuk*
ke fungsi.

### 3. Rahasia webhook: hex, jangan base64

Telegram hanya menerima `A-Z a-z 0-9 _ -` untuk `secret_token`.
`openssl rand -base64 32` — cara paling umum orang bikin string acak —
menghasilkan `+`, `/`, `=`. Akibatnya ganda: `setWebhook` ditolak, **dan**
`+` di query string dibaca browser sebagai spasi sehingga endpoint admin
menjawab 403 sebelum sempat mencoba. Gejalanya cuma "bot diam".

**Pakai `openssl rand -hex 32`.**

### 4. Zona waktu

Fungsi serverless berjalan di UTC. Tanpa `UTC_OFFSET_MINUTES`, "hari ini"
versi server berganti jam 07:00 WIB — hitungan "selesai hari ini" mereset di
tengah pagi kerja, dan jam pada "PC offline sejak …" tercetak tujuh jam
lebih awal dari jam dinding.

### 5. Selalu balas 200 ke webhook chat

Non-2xx = platform mengirim ulang update yang sama = command jalan dua kali.
Tapi **jangan diam ke user**: bot yang diam total tidak bisa dibedakan dari
webhook yang tidak terpasang, dan orang akan mencari di tempat yang salah.
Log error, kirim kalimat, balas 200.

### 6. Referensi API desktop: dua jalur

Autodesk tidak mengizinkan `RevitAPI.dll` disalin ke repo, dan runner CI
tidak punya Revit. Tanpa jalur kedua, build otomatis mustahil.

```xml
<UseInstalledRevitApi Condition="Exists('$(RevitDir)RevitAPI.dll')">true</UseInstalledRevitApi>
<!-- ada Revit  → Reference HintPath, Private=false -->
<!-- tanpa Revit → PackageReference assembly REFERENSI, ExcludeAssets=runtime -->
```

Kunci ke versi **terendah** yang didukung: DLL yang di-compile terhadap API
lama tetap jalan di rilis lebih baru, sebaliknya tidak.

`ExcludeAssets=runtime` / `Private=false` bukan opsional — aplikasinya sudah
memuat DLL itu sendiri, dan salinan kedua berarti dua tipe bernama sama di
satu AppDomain.

### 7. Versi yang dilaporkan agen

Baca `AssemblyInformationalVersion`, **bukan** `GetName().Version`. Yang
kedua selalu empat angka: suffix prerelease dibuang, jadi build CI
`0.1.0-dev.42` terbaca `0.1.0.0` dan tak bisa dibedakan dari rilis.

### 8. Export presisi (kalau outputnya gambar teknis)

```csharp
PaperFormat    = ExportPaperFormat.ISO_A1,   // atau auto-deteksi titleblock
MarginType     = MarginType.NoMargin,        // BUKAN Default/PrinterLimit
ZoomType       = ZoomType.Zoom,
ZoomPercentage = 100,                        // BUKAN FitToPage
```

| Salah | Akibat |
|---|---|
| `MarginType.Default` | Konten bergeser ~5 mm, skala tidak 1:1 |
| `ZoomType.FitToPage` | Skala rusak — fatal untuk shop drawing |
| `PaperFormat` tak cocok | A1 dicetak ke A4, mengecil |

Di sisi chat: **`sendDocument`, jangan `sendPhoto`** — yang kedua mengompres
jadi JPG dan presisi hilang. Nama berkas sertakan project + tanggal.
Preview di chat memang kasar; berkas aslinya utuh.

### 9. Manifest add-in: GUID unik

Salin project untuk bot kedua tanpa mengganti `ClientId` → aplikasi hanya
memuat salah satu. `[guid]::NewGuid()` di PowerShell.

### 10. SQL Editor menjalankan seluruh skrip dalam SATU transaksi

Versi pertama migrasi storage di repo ini memuat
`alter table storage.objects enable row level security`. Supabase menjawab:

```
ERROR: 42501: must be owner of table objects
```

`storage.objects` dimiliki `supabase_storage_admin`, sementara SQL Editor
berjalan sebagai `postgres`. Yang membuatnya mahal bukan errornya: karena satu
transaksi, **`insert` bucket di baris atasnya ikut di-rollback**. Orang
mengira migrasinya sudah jalan padahal tidak ada yang terbentuk.

Pelajarannya umum: satu baris gagal di tengah skrip = **seluruh** skrip tidak
terjadi. Jangan campur pernyataan yang butuh hak berbeda dalam satu berkas
migrasi.

### 11. Langkah manual apa pun akan terlewat — bikin server yang mengerjakannya

Bucket storage di repo ini **dibuat sendiri server**: `/api/admin/setup`
membuatnya saat dibuka, dan kalau belum ada juga, export besar pertama
membuatnya sebelum mengunggah (`ensureBucket` di `api/_lib/storage.ts`).
Migrasi SQL-nya jadi opsional.

Itu perubahan yang lahir dari kejadian: langkah SQL manual pernah terlewat,
dan akibatnya bukan pesan kesalahan melainkan berkas yang tidak pernah
sampai. Setiap langkah setup manual adalah kegagalan senyap yang menunggu
waktunya — kalau bisa dikerjakan server saat pertama dibutuhkan, kerjakan di
sana.

Sisanya: bikin migrasi **aman diulang** (`if not exists`, `on conflict do
update`), dan kalau kolomnya belum ada, periksa dulu lalu turun ke perilaku
lama **sambil mengatakannya** — jangan biarkan PostgREST menolak seluruh
PATCH (lihat §8a).

---

## 10. Penjaga otomatis adalah bagian struktur

Karena kelas kerusakan di §8 tidak menimbulkan error, penjaganya tidak bisa
diserahkan ke ingatan. Lima penjaga, dan tiap satu menjawab kegagalan senyap
yang **sudah pernah terjadi**:

| Penjaga | Menangkap | Kenapa manual tidak cukup |
|---|---|---|
| `check-runtime.ts` | Format modul salah → seluruh endpoint mati | Meng-compile `api/` **persis seperti platform**, lalu benar-benar **memuat** tiap endpoint. Kalau produksi akan mati, perintah ini mati lebih dulu — di laptop |
| `check-i18n.ts` | Key hilang, placeholder `{n}` tak sama, deskripsi command lewat batas 256 char | Key hilang tidak error: `t()` fallback diam-diam |
| `check-commands.ts` | Daftar command server ↔ panel menyimpang | Panel menyalin daftar sengaja (tetap berguna saat API mati). Harganya: dua daftar yang bisa berbeda tanpa gejala |
| `check-addin.ts` | `}` hilang, byte NUL, `using` kurang | Satu-satunya yang meng-compile C# adalah CI. Tanpa ini, salah ketik baru ketahuan setelah satu putaran push→tunggu runner→baca log. **Ini bukan compiler** — lolos di sini tidak berarti compile |
| `simulate-job.ts` ★ | Rantai hasil utuh: berkas 20 MB sampai, berkas kecil tetap inline, body selalu <4,5 MB, bucket dibuat sendiri, storage mati tetap jadi kalimat, >50 MB ditolak dengan kalimat, laporan ganda tidak kirim dua kali | Menjalankan **handler yang sebenarnya** di atas storage tiruan (lewat HTTP sungguhan) dan chat tiruan (in-process, supaya isi berkas bisa diperiksa byte per byte). Satu-satunya yang bisa menangkap "semua hijau tapi berkasnya hilang" |

```jsonc
"check": "npm run typecheck && npm run check:i18n && npm run check:commands
          && npm run check:runtime && npm run check:addin && npm run simulate"
```

Dua workflow: `check.yml` (ubuntu, cepat, tiap push) dan `addin.yml`
(compile C#). Beri **keduanya** `workflow_dispatch` — pernah terjadi GitHub
berhenti membuat run dari event `push` selama beberapa jam, dan penjaga yang
tidak punya tombol manual jadi tidak bisa dijalankan sama sekali.

---

## 11. Checklist salin-project

Kalau menyalin repo ini untuk bot kedua, ini yang **harus** diganti. Yang
ditandai ⚠ menyebabkan kerusakan senyap kalau terlewat.

**Identitas agen desktop**

- [ ] ⚠ `ClientId` GUID di `addin/*.addin` — kalau sama, aplikasi hanya muat satu
- [ ] `<Name>`, `<VendorId>` di manifest
- [ ] `AssemblyName`, `RootNamespace` di `.csproj`
- [ ] Subfolder di target `DeployAddin`
- [ ] ⚠ Folder `%APPDATA%\<Nama>` di `TokenStore.cs` **dan** `Log.cs` —
      kalau sama dengan bot pertama, keduanya berebut satu berkas token
- [ ] `Entropy` DPAPI di `TokenStore.cs` (string versi)
- [ ] `BaseUrl` default + nama env override di `BridgeClient.cs`
- [ ] Header `User-Agent`
- [ ] `<RevitDir>` / versi API kalau targetnya rilis lain

**Server**

- [ ] Project Vercel baru → domain baru
- [ ] Env: `TELEGRAM_BOT_TOKEN`, ⚠ `TELEGRAM_WEBHOOK_SECRET` (**hex**),
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MACHINE_TOKEN`,
      `PANEL_URL`, `UTC_OFFSET_MINUTES`
- [ ] ⚠ `MACHINE_TOKEN` **beda** dari bot pertama
- [ ] Isi ulang `COMMANDS` di `api/_lib/commands.ts` sesuai domain baru
- [ ] Sesuaikan `LIMITS` + `HEAVY` di `api/_lib/limits.ts`
- [ ] Katalog i18n: buang teks yang khusus domain lama
- [ ] ⚠ Salin `api/package.json` **beserta komentar `//`-nya** — komentar itu
      satu-satunya yang menjelaskan kenapa berkas itu ada

**Database**

- [ ] Project Supabase baru
- [ ] Jalankan migrasi berurutan (`001` → `002` → `004`)
- [ ] ⚠ `002`: nyalakan RLS di **semua** tabel, tanpa policy. Kalau terlewat,
      anon key bisa membaca chat ID semua orang
- [ ] `003` (bucket storage) **opsional** — server membuatnya sendiri.
      Jalankan hanya kalau ingin menyiapkannya lebih dulu

**Sekali jalan setelah deploy**

- [ ] `set-token.ps1` di PC, lalu **restart** aplikasi desktopnya
- [ ] Buka `/api/admin/setup?secret=…` → pasang webhook + menu command
- [ ] ⚠ Tiap kali daftar command berubah, **pasang menu lagi** —
      `commands.ts` tidak menyentuh menu "/" di sisi chat
- [ ] Matikan sleep PC: `powercfg /change standby-timeout-ac 0`
      (sleep memutus polling walau aplikasinya terbuka)
- [ ] Insert baris `bot_users` pertama (dirimu, role `admin`)
- [ ] Set deskripsi bot: sebut **"internal, eksperimen"**, dan sebut bahwa
      aktif hanya saat aplikasinya terbuka. Ekspektasi otomatis lebih longgar

**Ganti platform chat (Telegram → Discord/Slack/WA)**
Yang berubah cuma `_lib/telegram.ts`, `web/`, dan verifikasi rahasia di
webhook. Antrean, batas, agen, dan seluruh `Commands/` tidak tersentuh —
itu memang gunanya lapisan ini dipisah.

---

## 12. Kapan naik level

Tambah hanya kalau pemicunya **benar-benar terjadi**. Sampai itu, semua di
bawah adalah kode yang harus dirawat tanpa memberi manfaat.

| Pemicu | Tambahan |
|---|---|
| PC desktop kedua | Tabel `machines` + `machine_id` di user & job. **`for update skip locked` ternyata tidak perlu** kalau satu user dipasangkan ke tepat satu PC: dua PC tidak akan pernah memperebutkan baris yang sama. Yang wajib justru penyapuan per-PC — lihat §5 pola #6 |
| Sering bolak-balik >1 dokumen/hari | `open_docs` + pilihan project per user (`004`) |
| Berkas sering >50 MB | Storage + tabel `artifacts` + signed URL berumur |
| Butuh audit formal | Kolom log lengkap + retensi |
| Setting export bervariasi | Tabel `export_profiles` |
| >10 user | Rate limit per user di server, bukan cuma cooldown |

---

## 13. Urutan bangun

Urutan ini bukan selera. Langkah 1 kecil tapi **membuktikan seluruh rantai**;
sesudah itu semuanya cuma menambah berkas di `Commands/`.

```
0. Kerangka mati       → deploy /api/health, DB kosong, agen polling
                          Selesai kalau: last_seen_at bergerak di DB
1. /status             → chat → server → DB → polling → main thread → balik
                          Selesai kalau: HP menampilkan versi app + nama dokumen
2. 1 command read-only → yang nilainya nyata sehari-hari
                          Selesai kalau: angkanya SAMA PERSIS dengan yang
                          sudah ada di aplikasinya (validasi logika)
3. 1 command export    → berkas sungguhan
                          Selesai kalau: simulate-job hijau DAN berkas nyata
                          sampai utuh di chat
   ── pakai sendiri satu minggu penuh ──
4. undang 1 rekan      → bukan 5
5. sisa command read-only
6. modifikasi (dryRun → konfirmasi → eksekusi), kalau memang diminta
```

Jangan undang 5 orang sebelum stabil — kalau ada bug, kamu jadi support desk
sambil memperbaiki.

**Validasi logika di langkah 2 tidak boleh dilewat.** Jalankan sekali,
bandingkan dengan schedule/laporan yang sudah ada di aplikasinya. Kalau
angkanya sama persis, logika filternya benar dan hasil berikutnya bisa
dipercaya. Kalau tidak, semua command sesudahnya membangun di atas angka yang
salah — dan angka yang salah tapi masuk akal jauh lebih berbahaya daripada
error.

---

## 14. Yang sengaja TIDAK dibuat

Menolak fitur adalah keputusan desain, sama seperti menambahkannya.

| Tidak dibuat | Alasan |
|---|---|
| **Sync/commit ke central model** | Kalau muncul konflik, tidak bisa dinilai dari HP, dan kerusakannya menyebar ke seluruh tim. Cukup `/sync-status` yang read-only |
| **Hapus elemen apa pun** | Tidak ada alasan menghapus dari chat |
| **Endpoint heartbeat terpisah** | `claim` sudah merangkap, dan dua sumber "PC hidup" akan menyimpang |
| **Cron untuk penyapu** | `claim` datang tiap 4 detik dan membawa `busy` — informasi yang tidak dimiliki cron |
| **Ribbon / tombol di aplikasi** | Nol klik. Worker nyala dari `OnStartup`. Tombol yang harus ditekan setiap pagi adalah tombol yang akan terlupa |
| **Menegakkan izin di agen** | Server yang menyaring. Dua tempat penegakan = satu tempat yang akan menyimpang |
| **Menyembunyikan command sebagai keamanan** | Kosmetik. Viewer tetap bisa mengetik `/ifc` manual |

---

## Ringkasan satu halaman

1. Tiga batasan menentukan bentuk: **NAT → polling**, **API in-process →
   aplikasi wajib terbuka**, **main thread only → ExternalEvent**. Cek
   ketiganya sebelum menyalin.
2. Empat lapisan, peran tidak dicampur. **Aturan hidup di server.**
3. Satu sumber daftar command. Tambah kemampuan = **2 berkas**.
4. Tiga tabel. Payload `jsonb`. Target disimpan sebagai **nama**, bukan id.
5. Delapan pola agen di §5 tidak boleh dipangkas — semua sudah pernah gagal.
6. Musuhnya **kegagalan senyap**. Karena itu: fitur mati harus mati dengan
   kalimat, dan penjaganya ada di CI.
7. Bangun `/status` dulu. Ia kecil, dan ia membuktikan seluruh rantai.
