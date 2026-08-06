# Dual Language — Indonesia & English

Dua bahasa penuh: setiap balasan bot, setiap label panel web, dan setiap
deskripsi command di menu Telegram.

Berkas: `api/_lib/i18n/` (bot), `web/i18n.js` (panel),
`scripts/set-commands.ts` (menu Telegram), `scripts/check-i18n.ts` (penjaga).

---

## 1. Apa yang diterjemahkan, apa yang tidak

| Diterjemahkan | Tidak diterjemahkan | Alasan |
|---|---|---|
| Balasan bot | **Nama command** (`/count`, `/pdf`) | Nama command adalah API. Mengubahnya per bahasa membuat riwayat chat lama tidak bisa diketuk ulang |
| Deskripsi command di menu | Nama level & sheet dari Revit | Itu data model, bukan teks UI |
| Label panel web | Kunci payload JSON | Kontrak antar-mesin |
| Deskripsi bot di profil | Nama kategori Revit (`OST_…`) | Konstanta API Revit |

Alias Indonesia tetap disediakan untuk yang mengetik manual (`/lantai` →
`/levels`, `/hitung` → `/count`), tapi nama kanoniknya tetap satu.

---

## 2. Cara bahasa dipilih

```
1. bot_users.lang, kalau 'id' atau 'en'       ← pilihan eksplisit user
2. message.from.language_code                  ← 'id-ID' → 'id'
3. DEFAULT_LOCALE = 'id'
```

`lang = 'auto'` (default) berarti sengaja melompat ke langkah 2 **setiap kali**
ada pesan masuk — user yang mengganti bahasa HP-nya ikut berubah tanpa perlu
menjalankan `/lang` lagi.

Panel web memakai urutan yang sama, dengan
`Telegram.WebApp.initDataUnsafe.user.language_code` lalu `navigator.language`
sebagai sumber langkah 2.

---

## 3. Dua keputusan yang menentukan rasanya

**a. Konfirmasi ganti bahasa ditulis dalam bahasa BARU.**

```ts
await store.setLang(chatId, next);
const t = translator(resolveLocale(next, telegramLangCode));   // locale baru
return sendMessage(chatId, mdv2(t('lang.changed', { lang })));
```

"Bahasa diubah ke English" yang datang dalam Bahasa Indonesia terbaca seperti
perintahnya gagal.

**b. Bahasa dibekukan saat command dibuat**, disimpan di kolom `commands.lang`.

Command berjalan asinkron — `/ifc` bisa 15 menit. Kalau user mengganti bahasa di
tengah jalan, hasil yang datang tetap sebahasa dengan pesan "⏳" yang sedang
di-edit. Membaca ulang preferensi saat `report` akan menghasilkan satu pesan yang
separuhnya berganti bahasa.

---

## 4. Bentuk katalog

`id.ts` adalah acuan. `en.ts` wajib mengikuti — dipaksa dua lapis:

```ts
export const en = { … } satisfies Catalog;   // lapis 1: compile time
```

```bash
npx tsx scripts/check-i18n.ts                # lapis 2: CI
```

Kenapa dua lapis: `satisfies Catalog` menangkap kelompok yang hilang, tapi tidak
menangkap **key** yang hilang di dalam `Record<string, Node>`, dan sama sekali
tidak menangkap placeholder yang berbeda. Pemeriksa CI menangkap ketiganya:

1. Key yang ada di satu bahasa tapi tidak di bahasa lain
2. Placeholder `{n}` yang hilang di salah satu sisi
3. Deskripsi command di luar batas Telegram (3–256 karakter)

Ini penting karena key yang hilang **tidak** menyebabkan error runtime: `t()`
diam-diam fallback ke Bahasa Indonesia, dan user EN melihat balasan campur dua
bahasa tanpa ada yang tercatat di log.

### Aturan menulis string

- **Tidak ada karakter MarkdownV2 mentah di katalog.** Formatting dipasang di
  layer pengirim lewat `mdv2()`. Kalau katalog sudah mengandung `*tebal*`,
  escape ganda akan merusaknya
- **Placeholder pakai `{nama}`**, bukan gabungan string, supaya bisa dibandingkan
  antar-bahasa secara otomatis
- **Fungsi hanya kalau perlu logika** (plural, daftar dinamis). Selebihnya string
  biasa

---

## 5. Menu Telegram per bahasa

`setMyCommands` menerima `language_code`. Klien memilih daftar yang cocok dengan
bahasa aplikasinya, jadi user Indonesia melihat deskripsi Indonesia tanpa
melakukan apa pun.

```
setMyCommands({ commands })                            → default (fallback)
setMyCommands({ commands, language_code: 'id' })       → klien berbahasa Indonesia
setMyCommands({ commands, language_code: 'en' })       → klien berbahasa Inggris
setMyCommands({ commands, scope: { type:'chat', chat_id }, language_code })
                                                       → menu penuh untuk admin
```

Jalankan ulang setelah mengubah `api/_lib/commands.ts` atau katalog:

```bash
TELEGRAM_BOT_TOKEN=… ADMIN_CHAT_IDS=111,222 npx tsx scripts/set-commands.ts
```

Daftar default sengaja memakai teks Inggris: itu yang dilihat user dengan bahasa
aplikasi selain `id`/`en`.

---

## 6. Menambah bahasa ketiga

1. Buat `api/_lib/i18n/xx.ts`, salin dari `id.ts`, terjemahkan
2. Daftarkan di `LOCALES` dan `CATALOGS` (`i18n/index.ts`), plus tipe `Locale`
3. Tambahkan kamus di `web/i18n.js` dan `SUPPORTED`
4. `npx tsx scripts/check-i18n.ts` → perbaiki sampai hijau
5. `npx tsx scripts/set-commands.ts` → menu bahasa baru terpasang

Tidak ada tempat lain yang perlu disentuh — itulah tujuan katalog terpusat.

---

## 7. Menguji

```
[ ] /lang en → semua balasan berikutnya Bahasa Inggris
[ ] /lang auto + HP berbahasa Indonesia → balasan Bahasa Indonesia
[ ] /lang auto + HP berbahasa Inggris → balasan Bahasa Inggris
[ ] Konfirmasi ganti bahasa muncul dalam bahasa BARU
[ ] /help menampilkan section dan deskripsi dalam bahasa aktif
[ ] Ganti bahasa saat /ifc berjalan → hasilnya tetap sebahasa dengan "⏳"
[ ] Menu "/" berubah setelah set-commands.ts + restart Telegram
[ ] Panel web: toggle ID/EN/Auto mengubah seluruh label tanpa reload
[ ] Waktu relatif di panel ikut bahasa (Intl.RelativeTimeFormat)
[ ] check-i18n.ts hijau
```
