# Revit Bridge — Telegram Bot ↔ Revit

Bot Telegram untuk membaca dan mengekspor data model elektrikal Revit dari HP.
Dua bahasa (Indonesia / English), dua tema (terang / gelap), tanpa satu pun klik
di Revit.

**Konteks:** 5 user Telegram, 1 PC Revit (elektrikal), Revit 2025, `net8.0-windows`.

---

## Mulai dari mana

| Kalau kamu mau… | Baca |
|---|---|
| Memasang dan menjalankan botnya | **[docs/TELEGRAM-BOT-GUIDE.id.md](docs/TELEGRAM-BOT-GUIDE.id.md)** ([English](docs/TELEGRAM-BOT-GUIDE.en.md)) |
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
  _lib/
    i18n/           katalog ID + EN, resolusi bahasa
    commands.ts     daftar command: role, alias, section  (sumber tunggal)
    telegram.ts     escaping MarkdownV2, kirim pesan/file, verifikasi initData
  telegram/
    preferences.ts  handler /lang dan /theme
  panel/
    state.ts        data untuk panel web (butuh initData sah)
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
  set-commands.ts   pasang menu Telegram per bahasa + scope admin
  check-i18n.ts     penjaga konsistensi katalog (jalankan di CI)
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

Kerangka + dokumentasi. Yang belum ada dan menyusul sesuai urutan bangun di
panduan (§15): handler webhook penuh, endpoint `claim`/`report`, dan add-in
Revit (`addin/`). Mulai dari `/status` — command kecil itu membuktikan seluruh
rantai Telegram → Vercel → Supabase → polling → `ExternalEvent` → balik.
