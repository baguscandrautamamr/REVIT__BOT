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
addin/
  App.cs            OnStartup: buat ExternalEvent, start worker
  Polling/          loop polling — TANPA Revit API
  Events/           IExternalEventHandler — main thread
  Commands/         /levels /sheets /warnings /count /tray /find /pdf /schedule
  set-token.ps1     simpan machine token terenkripsi DPAPI
web/
  index.html        panel / Telegram Mini App
  theme.css         token + material kaca, light & dark
  panel.css         tata letak (tanpa satu pun warna literal)
  theme.js          pemilihan tema: light | dark | auto
  i18n.js           bahasa panel: id | en | auto
  app.js            perakitan + render
supabase/
  migrations/001_init.sql
scripts/
  deploy-bot.ps1    clone + npm ci + deploy konfigurasi bot (Windows)
  set-commands.ts   pasang webhook + menu Telegram per bahasa + scope admin
  check-i18n.ts     penjaga konsistensi katalog
  check-commands.ts penjaga sinkronisasi daftar command panel ↔ server
docs/
```

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
| Command di add-in | 8 dari 21 jalan — lihat tabel di bawah |

### Command yang sudah ada di add-in

`/levels` `/sheets` `/warnings` `/count` `/tray` `/find` `/pdf` `/schedule`

### Yang belum, dan kenapa

| Command | Yang menghalangi |
|---|---|
| `/panel` `/load` | Butuh API kelistrikan (`ElectricalSystem`, panel schedule). Nama parameter beban berbeda antar template — perlu dicocokkan dengan model asli dulu, menebaknya hanya menghasilkan angka yang salah tanpa terlihat salah. |
| `/png` `/dwg` | Opsi export-nya banyak dan mudah meleset (skala, layer mapping). Polanya sama dengan `ExportPdfCommand`. |
| `/nwc` `/ifc` | Perlu exporter Navisworks / IFC terpasang di PC-nya. |
| `/setparam` `/tag` `/dynamo` | Menunggu alur konfirmasi dua langkah di server (`onCallback` di `webhook.ts` masih kosong untuk `confirm:`). Modifikasi tanpa konfirmasi sengaja tidak dibuka. |

Command yang belum ada di add-in tetap dijawab ("belum diimplementasi"), bukan
menggantung. Mulai dari `/status`: command kecil itu membuktikan seluruh rantai
Telegram → Vercel → Supabase → polling → `ExternalEvent` → balik.

---

## Pemeriksaan sebelum deploy

```bash
npm run check     # typecheck + katalog dua bahasa + sinkronisasi daftar command panel
```

Ketiganya juga jalan otomatis di GitHub Actions (`.github/workflows/check.yml`).
Semuanya menangkap kerusakan yang TIDAK menimbulkan error saat runtime: key
terjemahan yang hilang diam-diam jatuh ke Bahasa Indonesia, dan daftar command
di panel yang menyimpang hanya menampilkan lebih sedikit tombol.
