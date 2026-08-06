# Revit Bridge — Telegram Bot ↔ Revit

Bot Telegram untuk membaca dan mengekspor data model elektrikal Revit dari HP.
Dua bahasa (Indonesia / English), dua tema (terang / gelap), tanpa satu pun klik
di Revit.

**Konteks:** 5 user Telegram, 1 PC Revit (elektrikal), Revit 2025, `net8.0-windows`.

---

## Mulai dari mana

| Kalau kamu mau… | Baca |
|---|---|
| **Memasang dari nol, langkah demi langkah** | **[docs/SETUP-LANGKAH.md](docs/SETUP-LANGKAH.md)** ← mulai di sini |
| Referensi lengkap semua sisi Telegram | [docs/TELEGRAM-BOT-GUIDE.id.md](docs/TELEGRAM-BOT-GUIDE.id.md) ([English](docs/TELEGRAM-BOT-GUIDE.en.md)) |
| Tahu kenapa arsitekturnya begini | [docs/CATATAN-ARSITEKTUR.md](docs/CATATAN-ARSITEKTUR.md) |
| Menambah/mengubah teks bot | [docs/DUAL-LANGUAGE.md](docs/DUAL-LANGUAGE.md) |
| Mengubah tampilan panel web | [docs/THEMING.md](docs/THEMING.md) |

---

## Bentuk singkat

```
Telegram → Vercel webhook → Supabase (antrean)
                                 ↑ polling 4 detik
                            Add-in Revit → ExternalEvent → Revit API
                                 ↓
                            report → edit pesan "⏳" + kirim file
```

PC Revit tidak punya IP publik, jadi semua komunikasi berupa *pull* dari add-in.
Revit API hanya hidup di dalam `Revit.exe` dan hanya boleh dipanggil dari main
thread — polling di background, eksekusi lewat `ExternalEvent`.

---

## Isi repo

```
api/
  health.ts         cek env + koneksi database (buka di browser setelah deploy)
  package.json      "type": "commonjs" — CARA Node memuat hasil compile
  tsconfig.json     "module": "CommonJS" — BENTUK hasil compile-nya
                    keduanya harus sepakat, kalau tidak semua endpoint mati;
                    dijaga oleh `npm run check:runtime`
  _lib/
    preferences.ts  handler /lang dan /theme
    i18n/           katalog ID + EN, resolusi bahasa
    commands.ts     daftar command: role, alias, section  (sumber tunggal)
    telegram.ts     escaping MarkdownV2, kirim pesan/file, verifikasi initData
    db.ts           akses Supabase lewat PostgREST (service role, server-only)
    limits.ts       batas per role, cooldown, ambang online, batas hari
    reply.ts        penyusun teks /help, /status, /queue, /users
    sweep.ts        tutup job mati (kedaluwarsa / ditinggal Revit) + kabari user
  telegram/
    webhook.ts      pintu masuk Telegram: validasi, routing, antrean
  machine/
    claim.ts        add-in ambil job (merangkap heartbeat)
    report.ts       add-in lapor hasil → edit pesan "⏳" + kirim file
  panel/
    state.ts        data untuk panel web (butuh initData sah)
    users.ts        tambah/cabut akses user — admin saja, dari panel
addin/                DLL siap pasang ada di tab Actions → workflow "addin"
  App.cs            OnStartup: buat ExternalEvent, start worker
  Polling/          loop polling — TANPA Revit API
  Events/           IExternalEventHandler — main thread
  Commands/         14 command + ViewFinder/LevelResolver/Layout (aturan bersama)
  Services/         BridgeClient (HTTP), DialogSuppressor, TokenStore, Log
  set-token.ps1     simpan machine token terenkripsi DPAPI
web/
  index.html        panel / Telegram Mini App
  theme.css         token + material kaca, light & dark
  panel.css         tata letak (tanpa satu pun warna literal)
  theme.js          pemilihan tema: light | dark | auto
  i18n.js           bahasa panel: id | en | auto
  app.js            perakitan + render
supabase/
  migrations/001_init.sql     tabel + machine_state
  migrations/002_security.sql RLS — service role saja
  migrations/003_storage.sql  catatan bucket job-files (bucket-nya dibuat server)
scripts/
  deploy-bot.ps1    clone + npm ci + deploy konfigurasi bot (Windows)
  set-commands.ts   pasang webhook + menu Telegram per bahasa + scope admin
  check-i18n.ts     penjaga konsistensi katalog
  check-commands.ts penjaga sinkronisasi daftar command panel ↔ server
  check-runtime.ts  penjaga format modul: emit CJS/ESM harus sepakat dengan
                    api/package.json, kalau tidak SEMUA endpoint mati
  simulate-job.ts   jalankan seluruh jalur hasil job di atas Supabase tiruan
docs/
```

---

## Export per grup sheet

Sheet di proyek nyata sudah dikelompokkan lewat parameter proyek — di sini
`ACT SHEET DISCIPLINE` (satu nilai untuk seluruh proyek) dan `ACT SHEET SERIES`
(yang membentuk sub-kategori di browser tree). Ketiga perintah ini bekerja di
atas pengelompokan itu, jadi tidak ada yang perlu mengetik 18 nomor sheet:

```bash
/sheets --groups              # daftar grup + isinya + perintah siap salin
/pdf --series "GENERAL-LV"    # satu grup → SATU PDF, dinamai menurut grupnya
/pdf --disc F_UTILITY         # seluruh discipline → satu PDF PER series, di-zip
```

Dua hal yang menentukan di sini:

**Nama berkas ikut nama grup.** Lewat daftar sheet, dua grup dengan jumlah sheet
yang sama dan dicetak di hari yang sama menghasilkan nama IDENTIK —
`PRJ_3sheets_2026-08-06.pdf` untuk GENERAL LV maupun GENERAL ELV. Di folder
unduhan keduanya bertabrakan dan yang kedua menimpa yang pertama.

**Satu nama series bisa jadi dua grup.** Proyek ini punya dua "GENERAL": set LV
(`ME-F-EL-…`) dan set ELV (`ME-F-EE-…`). Pembedanya diambil dari parameter urutan
yang terisi — `SERIES ORDER` untuk LV, `SERIES ORDER EE` untuk ELV — dan akhiran
`-LV` / `-ELV` hanya ditempel pada series yang memang bercabang. Tanpa pembedaan
itu, `--series GENERAL` menggabungkan cover LV dan cover ELV ke satu berkas.

**Em dash diterima sebagai `--`.** Papan ketik iOS dan Android mengganti dua
tanda hubung berurutan dengan em dash secara otomatis, jadi yang sampai ke bot
adalah `—disc`, satu karakter. Versi pertama fitur ini menolaknya dan menjawab
"Sheet tidak ditemukan: —disc" — pesan yang benar untuk pertanyaan yang salah.
`—`, `–`, dan satu tanda hubung untuk nama flag yang dikenal semuanya diterima
sekarang; nomor sheet berawalan hubung tetap dibaca sebagai nomor sheet. Lihat
`splitArgs` di `api/_lib/commands.ts`.

**`--disc` itu berat, dan `--series` yang dimaksudkan untuk dipakai sehari-hari.**
Satu discipline di proyek nyata bisa 25 sheet A1; satu PDF gabungan sebesar itu
mudah melewati batas kirim Telegram 50 MB, dan lama export-nya dihitung dalam
puluhan menit. Per series (2–4 sheet) selesai dalam hitungan menit, muat dikirim,
dan namanya langsung membedakan.

Job yang lama TIDAK lagi dibunuh penyapu selama add-in masih memegangnya —
ambangnya sekarang dipilih dari apa yang dilaporkan heartbeat, bukan dari satu
timer. Lihat `runningLimit` di `api/_lib/sweep.ts`.

Batas `maxSheets` per role ditegakkan di ADD-IN untuk jalur ini, bukan di server:
pemeriksaan di server menghitung panjang daftar sheet yang diketik, dan
permintaan per-grup cuma satu kata. Lihat `api/telegram/webhook.ts` di sekitar
`byGroup`, dan penjaganya di `scripts/simulate-job.ts` §11.

---

## Perintah yang sering dipakai

```bash
# Cek katalog dua bahasa konsisten (key + placeholder + batas Telegram)
npx tsx scripts/check-i18n.ts

# Pasang menu command: default, id, en, dan menu penuh untuk tiap admin
TELEGRAM_BOT_TOKEN=… ADMIN_CHAT_IDS=111,222 npx tsx scripts/set-commands.ts

# Periksa webhook
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

---

## Dua bahasa

| Nilai `bot_users.lang` | Artinya |
|---|---|
| `id` / `en` | Kunci ke satu bahasa |
| `auto` (default) | Ikut `from.language_code` dari Telegram |

Yang diterjemahkan: balasan bot, deskripsi command di menu, label panel web.
Yang tidak: nama command (`/count` tetap `/count`) — alias Indonesia disediakan
terpisah (`/hitung`, `/lantai`, `/bahasa`).

## Dua tema

| Nilai `bot_users.theme` | Artinya |
|---|---|
| `light` | Kaca putih — basis, tampilan default |
| `dark` | Kaca gelap |
| `auto` (default) | Ikut `Telegram.WebApp.colorScheme`, lalu `prefers-color-scheme` |

Tema gelap bukan hasil invert: kaca gelap tetap lapisan putih ber-alpha rendah,
karena alpha hitam di atas latar gelap hanya menghasilkan lubang mati. Reduce
transparency / reduce motion / high contrast dihormati dan benar-benar mengubah
tampilan.

---

## Status

| Bagian | Status |
|---|---|
| Server (webhook, claim, report, panel, health) | Lengkap, `npm run check` hijau |
| Dua bahasa + dua tema | Lengkap, `check-i18n` hijau |
| Panel web / Mini App | Lengkap, dirender & diuji di Chromium |
| Add-in Revit | Ditulis lengkap, **belum dikompilasi terhadap `RevitAPI.dll` asli** |
| Command di add-in | 14 dari 17 jalan — lihat tabel di bawah |

### Command yang sudah ada di add-in

`/levels` `/sheets` `/warnings` `/count` `/tray` `/find` `/panel` `/load`
`/pdf` `/png` `/dwg` `/ifc` `/nwc` `/schedule`

### Yang belum, dan kenapa

| Command | Yang menghalangi |
|---|---|
| `/setparam` `/tag` `/dynamo` | Menunggu alur konfirmasi dua langkah di server (`onCallback` di `webhook.ts` masih kosong untuk `confirm:`). Modifikasi tanpa konfirmasi sengaja tidak dibuka. |

Tiga yang sudah ada tapi bergantung pada hal di luar Revit sendiri:

| Command | Yang perlu diketahui |
|---|---|
| `/nwc` | Butuh add-in **Navisworks Exporters** terpasang di PC Revit — formatnya ditulis add-in Autodesk terpisah, bukan Revit. Kalau belum ada, `/nwc` menjawab dengan kalimat yang menyebutkan itu, bukan exception. |
| `/panel` `/load` | Angkanya dibaca dari parameter beban model (`RBS_ELEC_APPARENT_LOAD`, `ElectricalSystem`). Elemen yang parameternya kosong DILEWATI dan dihitung terpisah — nol yang tidak dijelaskan akan dikira beban yang memang nol. |
| `/pdf --series` `/dwg --series` | Mengelompokkan lewat parameter proyek `ACT SHEET SERIES`, dengan `SERIES ORDER` / `SERIES ORDER EE` sebagai pembeda LV/ELV. Nama parameternya ada di `addin/Commands/SheetGroups.cs` — kalau proyekmu memakai nama lain, ubah di sana. Kalau parameternya tidak ada, balasannya mendaftar parameter yang MEMANG ada di sheet, bukan cuma "tidak ditemukan". |

Command yang belum ada di add-in tetap dijawab ("belum diimplementasi"), bukan
menggantung. Mulai dari `/status`: command kecil itu membuktikan seluruh rantai
Telegram → Vercel → Supabase → polling → `ExternalEvent` → balik.

---

## Pemeriksaan sebelum deploy

```bash
npm run check     # lima pemeriksaan, berhenti di yang pertama gagal
```

| Pemeriksaan | Yang dijaga |
|---|---|
| `typecheck` | root + `api/` |
| `check:i18n` | katalog ID/EN: key, placeholder, batas panjang Telegram |
| `check:commands` | daftar command panel web ↔ server, termasuk penanda "belum jalan" |
| `check:runtime` | format modul fungsi Vercel — kalau menyimpang, SEMUA endpoint mati |
| `simulate` | seluruh jalur hasil job di atas Supabase + Telegram tiruan |

Kelimanya juga jalan otomatis di GitHub Actions (`.github/workflows/check.yml`).
Semuanya menangkap kerusakan yang TIDAK menimbulkan error saat runtime: key
terjemahan yang hilang diam-diam jatuh ke Bahasa Indonesia, daftar command di
panel yang menyimpang hanya menampilkan lebih sedikit tombol, dan berkas hasil
yang tidak pernah sampai cuma terlihat sebagai "⏳" yang tidak berubah.
