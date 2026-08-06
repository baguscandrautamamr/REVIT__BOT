# CATATAN — Telegram Bot ↔ Revit Bridge

Handoff untuk Claude Code. Berisi ruang lingkup, arsitektur, struktur data, dan cara operasi.

**Konteks:** 5 user Telegram, 1 PC Revit (elektrikal), Revit 2025, net8.0-windows.

> **Catatan versi.** Dokumen ini adalah catatan arsitektur asli, dipertahankan
> apa adanya sebagai rujukan keputusan. Tiga hal yang ditambahkan setelahnya
> punya dokumen sendiri:
>
> | Topik | Dokumen |
> |---|---|
> | Panduan Telegram lengkap (BotFather → batas byte) | [TELEGRAM-BOT-GUIDE.id.md](./TELEGRAM-BOT-GUIDE.id.md) · [English](./TELEGRAM-BOT-GUIDE.en.md) |
> | Dua bahasa (ID/EN) | [DUAL-LANGUAGE.md](./DUAL-LANGUAGE.md) |
> | Dua tema (light/dark, liquid glass) | [THEMING.md](./THEMING.md) |
>
> Yang berubah dari catatan di bawah: tabel `bot_users` bertambah kolom `lang`
> dan `theme`, tabel `commands` bertambah kolom `lang`, dan daftar command
> bertambah `/lang`, `/theme`, `/panelapp`. Skema final ada di
> `supabase/migrations/001_init.sql`.

---

## 1. Prinsip dasar

Tiga hal yang menentukan seluruh desain:

1. **PC tidak punya IP publik** → server tidak bisa "memanggil" add-in. Add-in yang harus keluar (outbound HTTP). Semua komunikasi berupa pull dari add-in.
2. **Revit API hanya hidup di dalam proses `Revit.exe`** → Revit wajib terbuka. Kalau ditutup, command mengantre sampai expired.
3. **Revit API hanya boleh dipanggil dari main thread** → polling di background, eksekusi lewat `ExternalEvent`.

Konsekuensi praktis: **nol klik di Revit.** Worker nyala otomatis dari `OnStartup`. Satu-satunya tombol adalah toggle pause (opsional).

---

## 2. Alur

### Command masuk

```
User Telegram
   ↓  /pdf LP-01
Vercel webhook          → validasi user, validasi limit, insert queue
   ↓
Supabase commands       → status: pending
   ↓  (add-in polling tiap 4 detik)
QueueWorker             → background thread, TIDAK menyentuh Revit API
   ↓  ExternalEvent.Raise()
CommandHandler          → main thread, di sinilah Revit API dipanggil
   ↓
Revit                   → doc.Export(...) / FilteredElementCollector
```

### Hasil balik

```
Revit selesai
   ↓
POST /api/machine/report   → hasil + file
   ↓
Supabase                   → status: done
   ↓
Telegram                   → edit pesan "⏳", kirim file/teks
```

### Batas thread (paling kritis)

| Lapisan | Boleh sentuh Revit API? |
|---|---|
| `QueueWorker` (background) | ❌ Tidak pernah. Hanya HTTP + titip payload |
| `CommandHandler.Execute()` (main) | ✅ Ya. Semua `Transaction`, `Export`, `Collector` |

---

## 3. Daftar command

### A. Info & status — read-only, instan

| Command | Role | Balasan |
|---|---|---|
| `/status` | viewer | Model terbuka, versi Revit, PC online sejak kapan |
| `/levels` | viewer | Daftar level (untuk tahu nama persis) |
| `/sheets` | viewer | Daftar sheet + revisi terakhir |
| `/warnings` | viewer | Jumlah warning aktif, 10 teratas |
| `/queue` | viewer | Antrean saat ini |
| `/help` | viewer | Daftar command sesuai role |

### B. Query data — read-only, nilai harian tertinggi

| Command | Role | Balasan |
|---|---|---|
| `/count L1` | viewer | Rekap 8 kategori MEP per lantai |
| `/count L1 lighting --detail` | viewer | Pecah per tipe family |
| `/tray L1` | viewer | Panjang cable tray per Comments (LV LADDER, dst) |
| `/panel LP-01` | viewer | Isi panel schedule: circuit, load, breaker |
| `/find MARK-123` | viewer | Lokasi elemen: level, koordinat |
| `/load L1` | viewer | Total connected load per lantai |

Kategori yang dihitung `/count`:

```
Lighting       → OST_LightingFixtures
Receptacle     → OST_ElectricalFixtures
Cable tray     → OST_CableTray            (+ total panjang meter)
Communication  → OST_CommunicationDevices
Fire alarm     → OST_FireAlarmDevices
Telephone      → OST_TelephoneDevices
Data / LAN     → OST_DataDevices
Security       → OST_SecurityDevices
```

### C. Export file

| Command | Role | Catatan |
|---|---|---|
| `/pdf LP-01 LP-02` | viewer (maks 10 sheet) | Presisi 1:1 |
| `/png` | viewer | Cepat, enak buat progress check. Tanpa argumen = daftar view 3D |
| `/dwg E-101` | admin | Ikut export setup tersimpan |
| `/nwc` | admin | Untuk Navisworks |
| `/ifc` | admin | Lambat, 5–15 menit |
| `/schedule PANEL-SCH` | viewer | CSV/XLSX dari `ViewSchedule.Export()` |

### D. Modifikasi — admin saja, konfirmasi dua langkah

| Command | Efek |
|---|---|
| `/setparam` | Isi Comments massal (coloring tray) |
| `/tag` | Tag otomatis di view aktif |
| `/dynamo` | Jalankan graph tersimpan |

Pola wajib: `dryRun` dulu → bot balas "akan mengubah 47 elemen [Ya] [Batal]" → eksekusi hanya setelah konfirmasi.

### E. Admin

| Command | Efek |
|---|---|
| `/pause` `/resume` | Hentikan/lanjutkan pengambilan job |
| `/cancel <id>` | Batalkan command yang antre |
| `/users` | Daftar user aktif |

### JANGAN dibuat

- **Sync with Central** — kalau muncul konflik/relinquish, tidak bisa dinilai dari HP, dan kerusakan menyebar ke tim. Cukup `/sync-status` yang read-only.
- **Delete elemen apa pun** — tidak ada alasan menghapus dari Telegram.

---

## 4. Struktur data

Dua tabel. Tidak lebih, sampai pemicunya muncul (lihat bagian 9).

```sql
create table bot_users (
  chat_id    bigint primary key,
  name       text not null,
  role       text not null default 'viewer',   -- viewer | admin
  is_active  boolean default true,
  created_at timestamptz default now()
);

create table commands (
  id           uuid primary key default gen_random_uuid(),
  chat_id      bigint not null references bot_users(chat_id),
  tg_message_id bigint,                 -- untuk edit pesan "⏳", bukan spam

  command      text not null,           -- 'pdf', 'count', 'status'
  payload      jsonb not null default '{}',

  status       text not null default 'pending',  -- pending|running|done|failed|expired|cancelled
  doc_title    text,                    -- diisi add-in saat eksekusi (audit)
  result       jsonb,
  error        text,

  started_at   timestamptz,
  finished_at  timestamptz,
  expires_at   timestamptz default now() + interval '10 minutes',
  created_at   timestamptz default now()
);

create index on commands (status, created_at);
create index on commands (chat_id, created_at desc);
```

### Kontrak payload

```jsonc
// pdf
{ "views": ["LP-01","LP-02"], "profile": "shop-drawing-a1" }

// count
{ "level": "Lantai 1", "detail": false }

// tray
{ "level": "Lantai 1", "groupBy": "comments" }
```

### Kontrak result

```jsonc
{
  "ok": true,
  "text": "📍 Lantai 1\nLighting : 184\n...",
  "file": { "name": "PRJ-B_LP-01_2026-08-06.pdf", "path": "/tmp/..." },
  "counts": { "processed": 2, "skipped": 0 }
}
```

---

## 5. Endpoint

Tiga saja.

| Endpoint | Pemanggil | Isi |
|---|---|---|
| `POST /api/telegram/webhook` | Telegram | Parse command, cek role + limit, insert queue |
| `POST /api/machine/claim` | Add-in, tiap 4 detik | Ambil 1 job FIFO. Sekaligus heartbeat (kirim `activeDoc`, `revitVersion`, `addinVersion`) |
| `POST /api/machine/report` | Add-in, saat selesai | Update status + kirim hasil ke Telegram |

`claim` merangkap heartbeat — server tahu PC hidup karena claim tetap masuk walau tidak ada job. Tidak perlu endpoint terpisah.

### Batas per role (di server, bukan add-in)

```js
const LIMITS = {
  viewer: { maxSheets: 10,  blocked: ['ifc','nwc','dwg','setparam','tag','dynamo'] },
  admin:  { maxSheets: 999, blocked: [] }
};
```

Cooldown 2 menit per user setelah command berat.

---

## 6. Struktur repo

```
revit-telegram-bridge/
├─ api/
│  ├─ telegram/webhook.ts
│  ├─ machine/claim.ts
│  ├─ machine/report.ts
│  └─ _lib/{auth,telegram,supabase,limits}.ts
├─ supabase/migrations/001_init.sql
└─ addin/
   ├─ App.cs                     # OnStartup: buat ExternalEvent, start worker
   ├─ Polling/QueueWorker.cs     # background loop — TANPA Revit API
   ├─ Events/CommandHandler.cs   # IExternalEventHandler — main thread
   ├─ Services/BridgeClient.cs   # HttpClient static
   ├─ Commands/
   │  ├─ IBotCommand.cs
   │  ├─ StatusCommand.cs
   │  ├─ CountByLevelCommand.cs
   │  └─ ExportPdfCommand.cs
   └─ RevitTelegramBridge.addin
```

Interface seragam supaya nambah command = tambah satu file:

```csharp
public interface IBotCommand {
    string Name { get; }
    string Role { get; }          // viewer | admin
    ExecResult Run(Document doc, JObject payload);
}
```

---

## 7. Empat hal yang TIDAK boleh dipangkas

Ini pencegah kerusakan, bukan optimasi.

**1. `ExternalEvent` untuk semua akses Revit API**
```csharp
_handler.Pending = job;
_externalEvent.Raise();      // eksekusi pindah ke main thread
```
Tanpa ini → Revit crash acak.

**2. `HttpClient` static**
```csharp
private static readonly HttpClient _http = new HttpClient {
    Timeout = TimeSpan.FromSeconds(15)
};
```
Tanpa ini → socket exhaustion dalam beberapa jam (`TIME_WAIT` menumpuk).

**3. `try/catch` di dalam loop**
```csharp
while (!ct.IsCancellationRequested) {
    try { /* claim + raise */ }
    catch (Exception ex) { Log(ex); }
    await Task.Delay(idle > 15 ? 15000 : 4000, ct);
}
```
Tanpa ini → wifi putus sebentar, worker mati diam-diam tanpa jejak.

**4. Guard `doc.Title` sebelum eksekusi**
```csharp
if (!string.Equals(doc.Title, job.ExpectedDocTitle, StringComparison.OrdinalIgnoreCase))
    return ExecResult.Fail($"Model tidak cocok: {doc.Title}");
```
Tanpa ini → bisa dapat PDF sheet LP-01 dari project yang salah, dan tidak akan sadar.

Tambahan: `_cts.Cancel()` di `OnShutdown`, dan `IFailuresPreprocessor` untuk auto-dismiss warning saat export.

---

## 8. Setting export PDF presisi

Tiga yang menentukan skala 1:1:

```csharp
PaperFormat    = ExportPaperFormat.ISO_A1,   // atau auto-deteksi dari titleblock
MarginType     = MarginType.NoMargin,        // BUKAN Default/PrinterLimit
ZoomType       = ZoomType.Zoom,
ZoomPercentage = 100,                        // BUKAN FitToPage
```

| Salah | Akibat |
|---|---|
| `MarginType.Default` | Konten digeser ~5mm, skala tidak 1:1 |
| `ZoomType.FitToPage` | Skala rusak — fatal untuk shop drawing |
| `PaperFormat` tidak cocok | A1 dicetak ke A4, mengecil |

Auto-deteksi ukuran dari titleblock (`SHEET_WIDTH` / `SHEET_HEIGHT`, satuan feet × 304.8 = mm), toleransi ±3mm.

`doc.Export()` **tidak butuh `Transaction`** — read-only. Pakai `PDFExportOptions` (Revit 2022+), bukan `PrintManager` — jalur print driver memunculkan dialog dan menggantung.

### Sisi Telegram

- Wajib `sendDocument`, **jangan** `sendPhoto` (mengompres jadi JPG, presisi hilang)
- Batas 50 MB → lebih dari itu, upload ke Supabase Storage, kirim signed URL
- Nama file sertakan project + tanggal: `PRJ-B_LP-01_2026-08-06.pdf`
- Preview di chat memang kasar; file aslinya utuh

---

## 9. Operasi harian

### Yang perlu kamu lakukan
Buka Revit pagi hari. Selesai.

Worker nyala otomatis dari `OnStartup`, polling sampai Revit ditutup. Tidak ada tombol yang perlu ditekan.

### Setup sekali
- Copy `.addin` + DLL ke `%APPDATA%\Autodesk\Revit\Addins\2025\`
- Matikan sleep: `powercfg /change standby-timeout-ac 0` (sleep memutus polling walau Revit terbuka)
- Machine token simpan di `%APPDATA%` terenkripsi DPAPI (`ProtectedData.Protect`), **bukan** di dalam DLL

### Saat kamu sedang modeling
Dua pilihan:
- **Ideal:** buka local copy kedua di sesi Revit terpisah, bot melayani dari sesi itu
- **Praktis:** `/pause` — worker tetap polling (supaya `/status` jujur) tapi tidak ambil job

### Beban
Idle praktis nol — thread tidur, satu POST ~200 byte tiap 4 detik. Yang berat cuma eksekusi, dan itu seberat export manual biasa. Export 50 sheet A1 = Revit freeze 2–5 menit.

### Kalau Revit mati
Command tidak hilang, status `pending` → `expired` setelah 10 menit. Bot balas dari `last_seen_at`:

```
🔴 PC offline sejak 18:42 kemarin (14 jam).
Command diantre — jalan otomatis begitu Revit dibuka.
```

Kalimat "jalan otomatis" itu yang menenangkan. Orang tidak keberatan menunggu, mereka keberatan tidak tahu sampai kapan.

### Kill switch jarak jauh
Flag `bot_enabled` di Supabase → webhook langsung menolak semua. Lebih cepat daripada remote ke laptop.

---

## 10. Urutan bangun

```
1. /status                    → membuktikan seluruh rantai jalan
2. /count + /levels           → nilai harian nyata, read-only
3. /pdf                       → output nyata
   ── pakai sendiri 1 minggu ──
4. undang 1 rekan
5. /tray, /panel, /png
6. sisanya sesuai permintaan nyata
```

`/status` kecil tapi membuktikan Telegram → Vercel → Supabase → polling → ExternalEvent → balik. Kalau itu jalan, sisanya cuma menambah file di `Commands/`.

Jangan undang 5 orang sebelum stabil — kalau ada bug, kamu jadi support desk sambil memperbaiki.

---

## 11. Kapan naik level

Tambah hanya kalau pemicunya benar-benar terjadi:

| Pemicu | Tambahan |
|---|---|
| PC Revit kedua | Tabel `machines` + `claim_commands()` dengan `for update skip locked` |
| Sering bolak-balik 2 model/hari | Tabel `projects` + `project_models` + `/switch` |
| File sering >50 MB | Supabase Storage + tabel `artifacts` + signed URL |
| Butuh audit formal | Kolom log lengkap, retensi |
| Setting export bervariasi | Tabel `export_profiles` |

Sampai pemicunya muncul, semua itu kode yang harus dirawat tanpa memberi manfaat.

---

## 12. Ekspektasi

Set deskripsi bot di BotFather:

> ⚡ Bot data model elektrikal. Aktif saat Revit terbuka (jam kerja). Bukan layanan 24/7.

Sebut ini **"bot internal, eksperimen"** — bukan "layanan". Ekspektasi otomatis lebih longgar, dan ada ruang kalau perlu dimatikan sementara.

---

## Catatan verifikasi

Beberapa hal yang perlu dicek langsung di model, karena tidak bisa diasumsikan:

- **Kategori family.** Banyak family fire alarm sebenarnya ter-load sebagai `Electrical Fixtures`, bukan `Fire Alarm Devices`. Pilih satu smoke detector di Revit, lihat kategorinya di Properties. Kalau meleset, `/count` akan bilang 0 padahal ada puluhan.
- **Level parameter.** `LevelId` sering kosong untuk elemen MEP. Cable tray pakai `RBS_START_LEVEL_PARAM`, family instance pakai `FAMILY_LEVEL_PARAM`. Sediakan fallback ketiganya.
- **Elemen di link tidak terhitung** oleh `FilteredElementCollector(doc)`.
- **Nama enum `PDFExportOptions`** — ditulis dari ingatan API 2025. Kalau ada yang tidak compile, cek `RevitAPI.chm`.

Validasi awal: jalankan `/count` sekali, bandingkan dengan schedule yang sudah ada di Revit. Kalau angkanya sama persis, logika level sudah benar dan hasil berikutnya bisa dipercaya.
