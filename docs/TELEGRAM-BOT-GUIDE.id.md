# Panduan Lengkap Telegram Bot — Revit Bridge

Bahasa: **Indonesia** · [English](./TELEGRAM-BOT-GUIDE.en.md)

Panduan ini menutup seluruh sisi Telegram: dari membuat bot di BotFather
sampai batas byte yang bikin `sendMessage` gagal 400. Angka dan nama method
di sini mengikuti Telegram Bot API; bagian yang perlu dicek ulang ditandai
**[verifikasi]** di bagian akhir.

---

## Daftar isi

1. [Bentuk sistemnya](#1-bentuk-sistemnya)
2. [Membuat bot di BotFather](#2-membuat-bot-di-botfather)
3. [Token dan keamanannya](#3-token-dan-keamanannya)
4. [Webhook](#4-webhook)
5. [Menu command dua bahasa](#5-menu-command-dua-bahasa)
6. [Daftar command lengkap](#6-daftar-command-lengkap)
7. [Preferensi user: /lang dan /theme](#7-preferensi-user-lang-dan-theme)
8. [Batas keras Telegram](#8-batas-keras-telegram)
9. [Format pesan (MarkdownV2)](#9-format-pesan-markdownv2)
10. [Mengirim file](#10-mengirim-file)
11. [Tombol, callback, konfirmasi dua langkah](#11-tombol-callback-konfirmasi-dua-langkah)
12. [Panel web (Mini App)](#12-panel-web-mini-app)
13. [Error, retry, rate limit](#13-error-retry-rate-limit)
14. [Peran dan izin](#14-peran-dan-izin)
15. [Checklist deploy](#15-checklist-deploy)
16. [Troubleshooting](#16-troubleshooting)
17. [Yang perlu diverifikasi sendiri](#17-yang-perlu-diverifikasi-sendiri)

---

## 1. Bentuk sistemnya

```
User Telegram
   │  /pdf LP-01
   ▼
Telegram ──webhook──► Vercel (/api/telegram/webhook)
                          │ validasi user, role, limit
                          ▼
                      Supabase (tabel commands, status: pending)
                          ▲
                          │ POST /api/machine/claim  ← add-in polling tiap 4 detik
                          │ (sekaligus heartbeat)
                      Add-in Revit
                          │ ExternalEvent.Raise() → main thread
                          ▼
                      Revit API (export / collector)
                          │
                          ▼
                      POST /api/machine/report ──► edit pesan "⏳" + kirim file
```

Tiga hal yang menentukan bentuk ini:

1. **PC Revit tidak punya IP publik.** Server tidak bisa memanggil add-in;
   add-in yang harus keluar. Semua komunikasi berupa *pull*.
2. **Revit API hanya hidup di dalam proses `Revit.exe`.** Revit harus terbuka.
   Kalau ditutup, command mengantre sampai kedaluwarsa (10 menit).
3. **Revit API hanya boleh dipanggil dari main thread.** Polling di background,
   eksekusi lewat `ExternalEvent`.

Akibat praktisnya: **nol klik di Revit.** Worker nyala dari `OnStartup`.

---

## 2. Membuat bot di BotFather

Chat ke [@BotFather](https://t.me/BotFather).

### Langkah wajib

| Perintah | Isi | Catatan |
|---|---|---|
| `/newbot` | nama tampilan, lalu username | Username **wajib** berakhiran `bot` atau `_bot`, dan unik global |
| — | simpan token yang muncul | Formatnya `123456789:AAF…`, bagian sebelum `:` adalah bot ID |
| `/setprivacy` | **Enabled** | Privacy mode aktif = di grup, bot hanya menerima pesan yang diawali `/` atau reply ke bot. Untuk bot internal ini, biarkan aktif |
| `/setjoingroups` | **Disable** | Bot ini dipakai di chat privat. Menutup pintu grup mengurangi permukaan serangan |

### Langkah kosmetik (dianjurkan)

| Perintah | Batas | Muncul di mana |
|---|---|---|
| `/setdescription` | ~512 karakter | Layar chat kosong, sebelum pesan pertama |
| `/setabouttext` | ~120 karakter | Halaman profil bot dan hasil pencarian |
| `/setuserpic` | gambar persegi | Avatar |
| `/setcommands` | lihat §5 | Menu `/` di kotak ketik |

> **Jangan pakai `/setcommands` dari BotFather untuk bot ini.** BotFather hanya
> bisa memasang satu daftar tanpa bahasa dan tanpa scope. Dukungan dua bahasa
> dan penyembunyian command admin butuh method API `setMyCommands` — lihat §5.
> Script `scripts/set-commands.ts` sudah mengerjakannya.

### Teks deskripsi yang dipakai

Indonesia:

> ⚡ Bot data model elektrikal Revit. Aktif saat Revit terbuka (jam kerja).
> Bot internal, bukan layanan 24/7.

Inggris:

> ⚡ Revit electrical model bot. Live while Revit is open (working hours).
> Internal tool, not a 24/7 service.

Menyebutnya "bot internal, eksperimen" sejak awal itu bukan basa-basi: ekspektasi
orang otomatis lebih longgar, dan ada ruang untuk mematikan sementara tanpa
terasa seperti *outage*.

---

## 3. Token dan keamanannya

Token adalah kredensial penuh. Siapa pun yang memegangnya bisa membaca semua
pesan masuk dan mengirim atas nama bot.

| Aturan | Alasan |
|---|---|
| Simpan di environment variable (`TELEGRAM_BOT_TOKEN`), bukan di repo | Repo bisa jadi publik, riwayat git tidak bisa dihapus rapi |
| Jangan pernah masukkan ke DLL add-in | DLL ada di PC yang bisa disalin siapa saja. Add-in memakai *machine token* terpisah |
| Machine token di PC: simpan di `%APPDATA%` terenkripsi DPAPI (`ProtectedData.Protect`) | Terikat ke akun Windows; disalin ke PC lain jadi sampah |
| Kalau bocor: `/revoke` di BotFather | Token lama langsung mati, webhook harus dipasang ulang |

Env yang dipakai proyek ini:

```bash
TELEGRAM_BOT_TOKEN=123456789:AAF…      # dari BotFather
TELEGRAM_WEBHOOK_SECRET=…              # 1–256 char, [A-Za-z0-9_-]
SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…            # server-only, JANGAN ke klien
MACHINE_TOKEN=…                        # dipakai add-in untuk claim/report
PANEL_URL=https://…/web/index.html     # Mini App
ADMIN_CHAT_IDS=111111111,222222222     # untuk set-commands.ts
```

---

## 4. Webhook

### Memasang

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://proyek-kamu.vercel.app/api/telegram/webhook",
    "secret_token": "'"$TELEGRAM_WEBHOOK_SECRET"'",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true,
    "max_connections": 20
  }'
```

| Parameter | Kenapa dipakai begitu |
|---|---|
| `url` | **Wajib HTTPS.** Port yang diterima: 443, 80, 88, 8443. Vercel = 443 |
| `secret_token` | Telegram akan mengirimnya di header `X-Telegram-Bot-Api-Secret-Token`. Tanpa ini, siapa pun yang tahu URL-nya bisa mengirim update palsu |
| `allowed_updates` | Batasi ke yang dipakai saja. Update lain tidak dikirim = lebih sedikit invocation Vercel |
| `drop_pending_updates` | Saat deploy ulang, buang antrean lama supaya command basi tidak ikut jalan |
| `max_connections` | 1–100, default 40. Untuk 5 user, 20 lebih dari cukup |

### Memeriksa

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Yang perlu dilihat di hasilnya:

- `pending_update_count` — kalau menumpuk, handler kamu lambat atau error
- `last_error_date` / `last_error_message` — penyebab paling sering: handler
  balas non-2xx, atau timeout
- `ip_address`, `url` — pastikan menunjuk deploy yang benar

### Aturan handler

1. **Balas 200 secepat mungkin.** Telegram menganggap non-2xx sebagai gagal dan
   akan mengirim ulang update yang sama. Kerja berat (query Revit) tidak boleh
   ditunggu di dalam handler — cukup masukkan ke tabel `commands`, balas "⏳",
   lalu `return 200`.
2. **Verifikasi header rahasia sebelum apa pun.**
   ```ts
   if (!verifyWebhookSecret(req.headers.get('x-telegram-bot-api-secret-token')))
     return new Response('forbidden', { status: 403 });
   ```
3. **Idempoten terhadap `update_id`.** Retry Telegram membawa `update_id` yang
   sama. Simpan `update_id` terakhir (atau unique index) supaya `/pdf` tidak
   jalan dua kali gara-gara satu timeout.
4. **`setWebhook` dan `getUpdates` saling meniadakan.** Kalau pernah mencoba
   long polling saat debugging, jalankan `deleteWebhook` dulu — dan sebaliknya.

### Bentuk update yang dipakai

```jsonc
// message
{
  "update_id": 123,
  "message": {
    "message_id": 45,
    "from": { "id": 111, "language_code": "id", "first_name": "Bagus" },
    "chat": { "id": 111, "type": "private" },
    "date": 1780000000,
    "text": "/pdf LP-01",
    "entities": [{ "type": "bot_command", "offset": 0, "length": 4 }]
  }
}
```

`from.language_code` inilah yang dipakai mode bahasa **auto** (§7). Nilainya
bisa `id`, `en`, `en-GB`, dst — ambil bagian sebelum tanda hubung.

---

## 5. Menu command dua bahasa

Yang diterjemahkan adalah **deskripsi** command, bukan namanya. Nama command
tetap Bahasa Inggris di semua bahasa karena itulah yang dikenali menu Telegram
lintas klien — dan mengganti nama command per bahasa akan membuat riwayat chat
lama tidak bisa diketuk ulang.

```ts
// Menu default — fallback untuk semua bahasa yang tidak punya daftar khusus
setMyCommands({ commands })

// Menu Bahasa Indonesia: klien dengan bahasa aplikasi "id" akan memakai ini
setMyCommands({ commands: commandsID, language_code: 'id' })

// Menu Bahasa Inggris
setMyCommands({ commands: commandsEN, language_code: 'en' })
```

Aturan yang mengikat:

| Hal | Batas |
|---|---|
| Jumlah command per daftar | maks 100 |
| Nama command | 1–32 karakter, hanya `a-z`, `0-9`, `_` |
| Deskripsi | 3–256 karakter |
| `language_code` | kode ISO 639-1 dua huruf (`id`, `en`), atau kosong untuk default |

`scripts/check-i18n.ts` memaksa batas nama & deskripsi ini saat CI, jadi menu
yang melanggar aturan tidak akan sampai ke produksi.

### Menyembunyikan command admin

Command admin tidak dimasukkan ke daftar default. Ia dipasang per chat:

```ts
setMyCommands({
  commands: commandsAdmin,
  scope: { type: 'chat', chat_id: 111111111 },
  language_code: 'id',
})
```

Scope yang tersedia (dari paling umum ke paling spesifik):
`default` → `all_private_chats` → `all_group_chats` → `all_chat_administrators`
→ `chat` → `chat_administrators` → `chat_member`. Yang paling spesifik menang.

> **Penting:** menyembunyikan dari menu **bukan** kontrol akses. Viewer tetap
> bisa mengetik `/ifc` manual. Penegakan role terjadi di webhook (§14), dan
> harus tetap ada walaupun menunya sudah rapi.

### Deskripsi bot per bahasa

`setMyDescription`, `setMyShortDescription`, dan `setMyName` juga menerima
`language_code`. Ketiganya sudah dipasang oleh script yang sama:

```bash
TELEGRAM_BOT_TOKEN=… ADMIN_CHAT_IDS=111,222 npx tsx scripts/set-commands.ts
```

Jalankan ulang setiap kali `api/_lib/commands.ts` atau katalog i18n berubah.

---

## 6. Daftar command lengkap

Kolom **Role**: `viewer` bisa dipakai semua user aktif; `admin` hanya admin.
Kolom **Alias**: bisa diketik sebagai ganti nama kanonik.

### A. Info & status — read-only, balasan instan

| Command | Alias ID | Role | Argumen | Balasan |
|---|---|---|---|---|
| `/status` | — | viewer | — | PC online/offline, model terbuka, versi Revit + add-in, ringkasan antrean |
| `/levels` | `/lantai`, `/level` | viewer | — | Daftar level beserta elevasi. Pakai ini untuk tahu nama persis sebelum `/count` |
| `/sheets` | `/lembar` | viewer | `[filter]` | Daftar sheet + revisi terakhir. Filter opsional mencocokkan nomor/nama |
| `/warnings` | `/peringatan` | viewer | — | Jumlah warning aktif + 10 teratas |
| `/queue` | `/antrean`, `/antrian` | viewer | — | Antrean saat ini beserta posisi command milikmu |
| `/help` | `/bantuan` | viewer | — | Daftar command sesuai role, dalam bahasa aktif |

### B. Data model — read-only, nilai harian tertinggi

| Command | Alias ID | Role | Contoh | Balasan |
|---|---|---|---|---|
| `/count` | `/hitung` | viewer | `/count L1`<br>`/count L1 lighting --detail` | Rekap 8 kategori MEP per lantai. `--detail` memecah per tipe family |
| `/tray` | — | viewer | `/tray L1` | Panjang cable tray dikelompokkan per `Comments` (LV LADDER, dst) |
| `/panel` | — | viewer | `/panel LP-01` | Isi panel schedule: circuit, load, breaker |
| `/find` | `/cari` | viewer | `/find MARK-123` | Lokasi elemen: level, koordinat, kategori |
| `/load` | `/beban` | viewer | `/load L1` | Total connected load per lantai |

Kategori yang dihitung `/count`:

```
Lampu          → OST_LightingFixtures
Stop kontak    → OST_ElectricalFixtures
Cable tray     → OST_CableTray            (+ total panjang meter)
Komunikasi     → OST_CommunicationDevices
Fire alarm     → OST_FireAlarmDevices
Telepon        → OST_TelephoneDevices
Data / LAN     → OST_DataDevices
Sekuriti       → OST_SecurityDevices
```

### C. Export file

| Command | Role | Contoh | Catatan |
|---|---|---|---|
| `/pdf` | viewer (maks 10 sheet) | `/pdf LP-01 LP-02` | Skala presisi 1:1 — setelan wajibnya di §10 |
| `/png` | viewer | `/png 3D-ELEC` | Cepat, cocok untuk progress check |
| `/schedule` | viewer | `/schedule PANEL-SCH` | CSV dari `ViewSchedule.Export()` |
| `/dwg` | admin | `/dwg E-101` | Memakai export setup yang tersimpan di model |
| `/nwc` | admin | `/nwc` | Untuk Navisworks |
| `/ifc` | admin | `/ifc` | Lambat: 5–15 menit. Bot mengabari di awal |

### D. Modifikasi — admin, wajib konfirmasi dua langkah

| Command | Efek |
|---|---|
| `/setparam` | Isi parameter massal, mis. `Comments` untuk *coloring* tray |
| `/tag` | Tag otomatis di view aktif |
| `/dynamo` | Jalankan graph Dynamo tersimpan |

Pola wajib: `dryRun` dulu → bot balas "akan mengubah 47 elemen [Ya] [Batal]" →
eksekusi hanya setelah tombol ditekan. Detail di §11.

### E. Administrasi

| Command | Role | Efek |
|---|---|---|
| `/pause` | admin | Worker berhenti mengambil job. Polling tetap jalan supaya `/status` tetap jujur |
| `/resume` | admin | Lanjut mengambil job |
| `/cancel <id>` | admin | Batalkan command yang masih `pending` |
| `/users` | admin | Daftar user terdaftar + role + status |

### F. Preferensi

| Command | Alias ID | Role | Efek |
|---|---|---|---|
| `/lang` | `/bahasa` | viewer | Ganti bahasa balasan: `id`, `en`, atau `auto` |
| `/theme` | `/tema` | viewer | Ganti tema panel web: `light`, `dark`, atau `auto` |
| `/panelapp` | `/panelweb` | viewer | Kirim tombol untuk membuka panel web |

### Yang sengaja TIDAK dibuat

| Tidak dibuat | Alasan |
|---|---|
| **Sync with Central** | Kalau muncul konflik atau permintaan relinquish, keputusannya tidak bisa diambil dari layar HP — dan kerusakannya menyebar ke seluruh tim. Cukup `/sync-status` yang read-only |
| **Delete elemen apa pun** | Tidak ada alasan menghapus dari Telegram. Satu salah ketik tidak boleh berarti kehilangan pekerjaan |
| **Ubah model tanpa konfirmasi** | Lihat §11 |

---

## 7. Preferensi user: /lang dan /theme

### Bahasa

Tiga nilai, disimpan di `bot_users.lang`:

| Nilai | Artinya |
|---|---|
| `id` | Selalu Bahasa Indonesia |
| `en` | Selalu Bahasa Inggris |
| `auto` (default) | Ikut `message.from.language_code` setiap kali ada pesan masuk |

Urutan penentuan (yang pertama menang):

```
1. bot_users.lang, kalau 'id' atau 'en'
2. from.language_code dari update Telegram    ('id-ID' → 'id')
3. DEFAULT_LOCALE = 'id'
```

Cara pakai:

```
/lang              → tampilkan tombol pilihan
/lang en           → kunci ke Bahasa Inggris
/lang auto         → ikut bahasa aplikasi Telegram
```

Dua detail yang mudah terlewat:

- **Balasan konfirmasi ganti bahasa memakai bahasa BARU.** Konfirmasi
  "Bahasa diubah ke English" yang masih berbahasa Indonesia terasa seperti gagal.
- **Bahasa dibekukan saat command dibuat** (kolom `commands.lang`). Kalau user
  mengganti bahasa selagi export berjalan, hasilnya tetap sebahasa dengan pesan
  "⏳" yang sedang di-edit.

Sisi implementasi: `api/_lib/i18n/`. Katalog `id.ts` adalah acuan bentuk;
`en.ts` wajib mengikuti key dan placeholder yang sama — dipaksa oleh
`satisfies Catalog` saat compile dan `scripts/check-i18n.ts` saat CI. Key yang
hilang tidak menyebabkan error runtime, ia diam-diam fallback ke Indonesia,
dan user EN melihat balasan campur. Karena itu pemeriksanya wajib jalan di CI.

### Tema

Tiga nilai, disimpan di `bot_users.theme`, berlaku untuk panel web:

| Nilai | Artinya |
|---|---|
| `light` (basis) | Kaca putih — tampilan default |
| `dark` | Kaca gelap |
| `auto` (default) | Ikut `Telegram.WebApp.colorScheme`, lalu `prefers-color-scheme` |

Detail desain tema ada di [THEMING.md](./THEMING.md).

---

## 8. Batas keras Telegram

Angka-angka ini yang paling sering menggigit. Simpan sebagai konstanta, jangan
dihafal.

| Hal | Batas |
|---|---|
| Panjang teks `sendMessage` | 4096 karakter |
| Panjang `caption` (dokumen/foto) | 1024 karakter |
| Upload file oleh bot | 50 MB |
| Download file oleh bot (`getFile`) | 20 MB |
| Upload lewat *local Bot API server* | hingga 2000 MB |
| `callback_data` pada tombol | 64 byte |
| Jumlah command per `setMyCommands` | 100 |
| Nama command | 1–32 char, `a-z0-9_` |
| Deskripsi command | 3–256 char |
| Pesan ke satu chat | ~1 per detik |
| Pesan ke satu grup | ~20 per menit |
| Total keluar | ~30 pesan per detik |
| `max_connections` webhook | 1–100 (default 40) |

Melewati batas kecepatan menghasilkan **429** dengan `parameters.retry_after`
dalam detik. Untuk 5 user, batas ini praktis tidak akan tersentuh — kecuali ada
loop yang salah. Kalau `/count` mengirim 40 pesan beruntun, itu bug, bukan
kebutuhan menaikkan limit.

---

## 9. Format pesan (MarkdownV2)

MarkdownV2 menolak **seluruh pesan** kalau ada satu karakter reserved yang tidak
di-escape. Daftarnya lebih panjang dari dugaan orang:

```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

Titik dan tanda hubung ikut di dalamnya. Artinya `LP-01.` — nama sheet biasa —
sudah cukup membuat `sendMessage` gagal `400 Bad Request`.

```ts
sendMessage(chatId, mdv2(`Sheet ${sheet} selesai.`));   // benar
sendMessage(chatId, `Sheet ${sheet} selesai.`);         // 400 kalau sheet = "LP-01"
```

Tiga pilihan, urut dari paling aman:

1. **Escape semua** lewat `mdv2()` (`api/_lib/telegram.ts`). Formatting dipasang
   setelah escape, bukan sebelum.
2. **Blok kode** untuk tabel dan daftar angka — di dalam ``` hanya `` ` `` dan
   `\` yang perlu di-escape, dan hasilnya rata karena monospace:
   ```
   Lampu       184
   Stop kontak  96
   Cable tray   38   412 m
   ```
3. **`parse_mode: 'HTML'`** — hanya `<`, `>`, `&` yang perlu di-escape. Lebih
   longgar, tapi tag yang didukung terbatas (`b i u s code pre a blockquote`).

Untuk balasan `/count` dan `/panel`, blok kode adalah pilihan terbaik: kolomnya
lurus di semua perangkat.

Pesan panjang: potong di **batas baris**, bukan di karakter ke-4096. `chunk()`
di `telegram.ts` melakukannya — tabel yang terbelah di tengah baris tidak
terbaca.

---

## 10. Mengirim file

### Aturan

| Aturan | Alasan |
|---|---|
| **`sendDocument`, bukan `sendPhoto`** | `sendPhoto` mengompres ke JPG dan menurunkan resolusi. Untuk shop drawing, presisinya hilang |
| Nama file sertakan project + tanggal | `PRJ-B_LP-01_2026-08-06.pdf` — di galeri HP, `LP-01.pdf` saja tidak berarti apa-apa dua minggu kemudian |
| Lebih dari 50 MB → Supabase Storage + signed URL | Bot API menolak upload di atas 50 MB |
| Preview di chat memang kasar | Itu render Telegram. File aslinya utuh — buka dengan aplikasi PDF, bukan preview |

### Setelan export PDF presisi (sisi Revit)

Tiga hal yang menentukan skala 1:1:

```csharp
PaperFormat    = ExportPaperFormat.ISO_A1,   // atau auto-deteksi dari titleblock
MarginType     = MarginType.NoMargin,        // BUKAN Default / PrinterLimit
ZoomType       = ZoomType.Zoom,
ZoomPercentage = 100,                        // BUKAN FitToPage
```

| Salah | Akibat |
|---|---|
| `MarginType.Default` | Konten bergeser ~5 mm, skala tidak lagi 1:1 |
| `ZoomType.FitToPage` | Skala rusak — fatal untuk shop drawing |
| `PaperFormat` tidak cocok | A1 tercetak ke A4, mengecil |

Auto-deteksi ukuran dari titleblock: `SHEET_WIDTH` / `SHEET_HEIGHT`, satuan feet
× 304.8 = mm, toleransi ±3 mm.

`doc.Export()` **tidak butuh `Transaction`** — operasinya read-only. Pakai
`PDFExportOptions` (Revit 2022+), **bukan** `PrintManager`: jalur print driver
memunculkan dialog dan menggantung proses tanpa ada yang bisa menekan OK.

### Mengunduh file dari user

Kalau nanti bot menerima file (mis. `.dyn` untuk `/dynamo`):

```
getFile(file_id) → file_path
GET https://api.telegram.org/file/bot<TOKEN>/<file_path>
```

Batas unduh 20 MB, dan `file_path` kedaluwarsa setelah sekitar satu jam — ambil
segera, jangan disimpan sebagai referensi jangka panjang.

---

## 11. Tombol, callback, konfirmasi dua langkah

### Inline keyboard

```ts
sendMessage(chatId, mdv2(text), {
  reply_markup: {
    inline_keyboard: [[
      { text: 'Ya',    callback_data: `confirm:${jobId}:yes` },
      { text: 'Batal', callback_data: `confirm:${jobId}:no`  },
    ]],
  },
});
```

`callback_data` maksimal **64 byte**. Jangan menaruh payload di situ — taruh
ID-nya saja, datanya di tabel. UUID penuh (36 char) sudah memakan lebih dari
separuh jatah; potong ke 8 karakter pertama kalau perlu ruang.

### Menjawab callback

**Selalu panggil `answerCallbackQuery`,** bahkan saat tidak ada yang perlu
dikatakan. Tanpa itu, tombol di klien berputar sampai timeout dan user menekan
dua kali.

```ts
await answerCallbackQuery(query.id, 'Dijalankan');
await editMessageText(chatId, messageId, mdv2('⚙️ Sedang dikerjakan…'));
```

### Pola konfirmasi

```
/setparam L1 tray Comments "LV LADDER"
   │
   ▼  dryRun — hitung saja, tidak mengubah apa pun
⚠️ Akan mengubah 47 elemen.
   Tindakan ini tidak bisa di-undo dari Telegram.
   [Ya] [Batal]
   │
   ▼  callback confirm:<id>:yes
✅ 47 elemen diubah.
```

Empat penjaga yang tidak boleh dilewat:

1. **Kedaluwarsa 2 menit.** Konfirmasi basi ditolak — model bisa sudah berubah.
2. **Hanya pemilik.** Bandingkan `callback_query.from.id` dengan `chat_id`
   pemilik job. Kalau tidak, admin lain bisa menyetujui perubahan orang lain.
3. **Sekali pakai.** Tandai job `consumed` sebelum eksekusi, supaya tekan dua
   kali tidak berarti jalan dua kali.
4. **Hitungan `dryRun` dikirim ulang saat eksekusi** dan dicek lagi di add-in.
   Kalau jumlahnya berubah, batalkan dan minta ulang.

---

## 12. Panel web (Mini App)

Panel di `web/` adalah Telegram Mini App: status PC, antrean, dan daftar command
yang bisa diketuk untuk disalin — plus toggle bahasa dan tema.

### Memasang tombol menu

Lewat BotFather: `/mybots` → pilih bot → **Bot Settings** → **Menu Button** →
kirim URL panel. Atau lewat API:

```ts
setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Panel', web_app: { url: PANEL_URL } },
});
```

Bisa juga dikirim sebagai tombol di dalam pesan (itulah yang dilakukan
`/panelapp`):

```ts
reply_markup: { inline_keyboard: [[
  { text: '📊 Panel', web_app: { url: PANEL_URL } },
]]}
```

URL wajib HTTPS.

### Otorisasi — bagian yang paling sering salah

Halaman menerima `window.Telegram.WebApp.initData`: string query yang
ditandatangani. **`initDataUnsafe` tidak boleh dipakai untuk otorisasi** —
namanya sudah memberi tahu alasannya. Kirim `initData` mentah ke server, dan
server memverifikasi:

```
secret = HMAC_SHA256(key="WebAppData", data=<bot_token>)
hash   = HMAC_SHA256(key=secret,       data=<data_check_string>)
```

`data_check_string` = semua pasangan `k=v` **kecuali** `hash`, diurutkan
alfabetis, digabung dengan `\n`.

Dua jebakan:

- **Login Widget memakai skema berbeda** (`secret = SHA256(bot_token)`).
  Tertukar = verifikasi selalu gagal, dan pesan errornya tidak menjelaskan apa pun.
- **Cek `auth_date`.** Tanpa batas umur, `initData` yang bocor bisa dipakai
  selamanya. Implementasi di sini menolak yang lebih tua dari 1 jam.

Implementasinya: `verifyInitData()` di `api/_lib/telegram.ts`, dipakai
`api/panel/state.ts`.

### Tema di dalam Mini App

Telegram menyediakan:

- `WebApp.colorScheme` — `'light'` atau `'dark'`
- `WebApp.themeParams` — juga tersedia sebagai CSS variable `--tg-theme-bg-color`,
  `--tg-theme-text-color`, `--tg-theme-button-color`, dan seterusnya
- event `themeChanged` saat user mengganti tema Telegram
- `setHeaderColor()` / `setBackgroundColor()` untuk menyamakan chrome di sekitar
  panel

Panel ini memakai `colorScheme` sebagai sinyal mode `auto`, tapi **tidak**
mengambil `themeParams` mentah sebagai warna. Alasannya: tema kaca butuh
hubungan spesifik antar lapisan (alpha bertingkat, garis pantul, bayangan) yang
tidak bisa direkonstruksi dari tujuh warna datar. Yang disamakan hanya warna
header dan background — supaya tidak ada pita putih di atas panel gelap.

---

## 13. Error, retry, rate limit

### Kode yang akan kamu temui

| Kode | Arti | Tindakan |
|---|---|---|
| `400 Bad Request: can't parse entities` | MarkdownV2 tidak di-escape | §9. Hampir selalu ini |
| `400 message is not modified` | `editMessageText` dengan teks identik | Abaikan, bukan kesalahan |
| `403 bot was blocked by the user` | User memblokir bot | Set `is_active = false`, berhenti mengirim |
| `429 Too Many Requests` | Kena rate limit | Tunggu `parameters.retry_after` detik, baru ulang |
| `413` / `Request Entity Too Large` | File > 50 MB | Naikkan ke Storage, kirim signed URL |
| `409 Conflict` | `getUpdates` dipakai bersamaan dengan webhook | `deleteWebhook` atau hentikan poller |

### Pola retry

Hanya ulangi yang memang bisa diulang: 429 dan error jaringan. Jangan ulangi 400
— hasilnya akan sama persis, hanya lebih berisik.

```ts
try {
  await sendMessage(chatId, text);
} catch (err) {
  if (err.retryAfter) {
    await sleep(err.retryAfter * 1000);
    await sendMessage(chatId, text);
  } else {
    log(err);          // jangan lempar keluar handler webhook:
  }                    // non-2xx = Telegram kirim ulang update yang sama
}
```

### Saat PC Revit mati

Command tidak hilang. Status `pending` → `expired` setelah 10 menit. Bot menjawab
dari `machine_state.last_seen_at`:

```
🔴 PC offline sejak 18:42 kemarin (14 jam).
Command tetap diantre — jalan otomatis begitu Revit dibuka.
```

Kalimat "jalan otomatis" itu yang bekerja. Orang tidak keberatan menunggu; mereka
keberatan tidak tahu sampai kapan.

### Kill switch

Flag `machine_state.bot_enabled` di Supabase. Webhook menolak semua command
begitu flag mati — lebih cepat daripada remote ke laptop, dan bisa dilakukan dari
dashboard Supabase lewat HP.

---

## 14. Peran dan izin

Ditegakkan di **server**, bukan di add-in dan bukan di menu.

```js
const LIMITS = {
  viewer: { maxSheets: 10,  blocked: ['ifc','nwc','dwg','setparam','tag','dynamo'] },
  admin:  { maxSheets: 999, blocked: [] },
};
```

Urutan pemeriksaan di webhook, semuanya sebelum job masuk antrean:

```
1. header rahasia webhook cocok?        → tidak: 403, berhenti
2. bot_enabled?                          → tidak: balas kill switch
3. chat_id terdaftar & is_active?        → tidak: balas "belum terdaftar"
4. command dikenal?                      → tidak: balas /help
5. role mencukupi?                       → tidak: balas "khusus admin"
6. argumen valid & dalam batas?          → tidak: balas contoh yang benar
7. cooldown lewat?                       → tidak: balas sisa detik
8. → insert ke commands, balas "⏳"
```

Cooldown 2 menit per user setelah command berat (`pdf`, `ifc`, `nwc`, `dwg`).

Menambah user: masukkan `chat_id` ke `bot_users`. Cara user mengetahui chat ID
sendiri — kirim pesan apa pun ke bot; balasan "belum terdaftar" menyertakan ID-nya.

---

## 15. Checklist deploy

```
[ ] Bot dibuat, token disimpan di env Vercel (bukan di repo)
[ ] TELEGRAM_WEBHOOK_SECRET dibuat acak, dipasang di env
[ ] Migrasi Supabase dijalankan (001_init.sql)
[ ] Baris bot_users diisi untuk tiap user + role
[ ] setWebhook dijalankan dengan secret_token + allowed_updates
[ ] getWebhookInfo diperiksa: tidak ada last_error_message
[ ] npx tsx scripts/check-i18n.ts  → hijau
[ ] npx tsx scripts/set-commands.ts → menu id + en + admin terpasang
[ ] Menu button Mini App menunjuk ke PANEL_URL
[ ] Add-in: .addin + DLL di %APPDATA%\Autodesk\Revit\Addins\2025\
[ ] Machine token tersimpan DPAPI di %APPDATA%
[ ] powercfg /change standby-timeout-ac 0   (sleep memutus polling)
[ ] /status dari HP → balasan benar. Ini membuktikan seluruh rantai
```

Urutan membangun yang dianjurkan:

```
1. /status                    → membuktikan seluruh rantai jalan
2. /count + /levels           → nilai harian nyata, read-only
3. /pdf                       → output nyata
   ── pakai sendiri 1 minggu ──
4. undang 1 rekan
5. /tray, /panel, /png
6. sisanya sesuai permintaan nyata
```

Jangan undang 5 orang sebelum stabil. Kalau masih ada bug, kamu jadi *support
desk* sambil memperbaikinya.

---

## 16. Troubleshooting

| Gejala | Kemungkinan besar | Cara cek |
|---|---|---|
| Bot diam total | Webhook gagal / salah URL | `getWebhookInfo` → `last_error_message` |
| Command jalan dua kali | Handler balas non-2xx, Telegram kirim ulang | Pastikan `return 200` walau ada error; dedupe `update_id` |
| `400 can't parse entities` | MarkdownV2 tidak di-escape | Bungkus semua teks dinamis dengan `mdv2()` |
| Menu `/` masih bahasa lama | `setMyCommands` belum dijalankan ulang, atau klien cache | Jalankan script, lalu tutup-buka Telegram |
| Menu `/` kosong di HP satu orang | Bahasa aplikasi orang itu bukan `id`/`en` | Daftar default (EN) seharusnya muncul — cek script memasang daftar tanpa `language_code` |
| Balasan campur dua bahasa | Ada key hilang di `en.ts`, fallback ke `id` | `npx tsx scripts/check-i18n.ts` |
| Panel selalu 401 | `initData` kedaluwarsa atau skema hash tertukar | Cek `auth_date` dan pastikan memakai `HMAC("WebAppData", token)`, bukan `SHA256(token)` |
| Panel terkunci terang di HP gelap | `data-theme="light"` terpasang saat preferensi `auto` | Mode auto harus **menghapus** atribut, bukan mengisinya |
| Kaca terlihat abu-abu mati | Latar di belakangnya rata | `backdrop-filter` butuh sesuatu untuk diaduk — lihat gradien di `body::before` |
| PDF skalanya meleset | `MarginType` / `ZoomType` salah | §10 |
| `/count` menjawab 0 padahal ada puluhan | Kategori family tidak seperti dugaan | Lihat §17 |
| Bot berhenti setelah beberapa jam | `HttpClient` dibuat per request → socket exhaustion | Gunakan satu instance `static` |
| Revit crash acak | Revit API dipanggil dari thread polling | Semua akses harus lewat `ExternalEvent` |

---

## 17. Yang perlu diverifikasi sendiri

Beberapa hal tidak bisa diasumsikan dan harus dicek langsung:

**Di Revit:**

- **Kategori family.** Banyak family fire alarm sebenarnya ter-load sebagai
  `Electrical Fixtures`, bukan `Fire Alarm Devices`. Pilih satu smoke detector,
  lihat kategorinya di Properties. Kalau meleset, `/count` melaporkan 0 padahal
  ada puluhan — dan tidak ada yang terlihat salah.
- **Parameter level.** `LevelId` sering kosong untuk elemen MEP. Cable tray
  memakai `RBS_START_LEVEL_PARAM`, family instance memakai `FAMILY_LEVEL_PARAM`.
  Sediakan fallback ketiganya.
- **Elemen di dalam link tidak terhitung** oleh `FilteredElementCollector(doc)`.
- **Nama enum `PDFExportOptions`** ditulis dari ingatan API 2025. Kalau ada yang
  tidak compile, cek `RevitAPI.chm`.

**Di Telegram:** angka batas dan nama parameter di panduan ini mengikuti Bot API
yang berlaku saat ditulis. Bot API bertambah method dan field secara berkala —
sebelum bergantung pada satu field, cocokkan dengan
[core.telegram.org/bots/api](https://core.telegram.org/bots/api). Yang paling
mungkin bergeser: daftar field `themeParams`, method Mini App terbaru, dan
batas ukuran unggah. **[verifikasi]**

**Validasi awal yang paling berguna:** jalankan `/count` sekali, bandingkan
dengan schedule yang sudah ada di Revit. Kalau angkanya sama persis, logika level
sudah benar dan hasil berikutnya bisa dipercaya.
