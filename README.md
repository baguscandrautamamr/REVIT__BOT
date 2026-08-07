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
| **Membangun bot serupa dari nol** (CAD/desktop lain, platform chat lain) | **[catatan.md](catatan.md)** — cetak biru + jebakan yang sudah dibayar |
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
    machines.ts     daftarkan/cabut PC Revit — token dibuat server, tanpa env var
    routing.ts      (di _lib) PC tujuan per user: pc | legacy | unassigned
addin/                DLL siap pasang ada di tab Actions → workflow "addin"
  App.cs            OnStartup: buat ExternalEvent, start worker
  Polling/          loop polling — TANPA Revit API
  Events/           IExternalEventHandler — main thread
  Commands/         16 command + ViewFinder/SheetGroups/Layout (aturan bersama)
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
  migrations/004_project_selection.sql  pilihan project per user (multi-file)
  migrations/005_machines.sql  daftar PC Revit + token-nya (opsional, lihat di dalamnya)
  migrations/006_machine_routing.sql  job diarahkan ke PC pemiliknya (opsional)
  migrations/007_machine_sharing.sql  PC boleh TERLIHAT di /active user lain (opsional)
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
/views                        # nama view 3D apa saja + perintah /png siap salin
/series                       # grup apa saja yang ada + perintah siap salin
/series --detail              # sama, plus nomor & nama tiap sheet
/pdf --series "GENERAL-LV"    # satu grup → SATU PDF, dinamai menurut grupnya
/pdf --disc F_UTILITY         # seluruh discipline → satu PDF PER series, di-zip
```

> **Setelah menambah command apa pun, menu `/` Telegram harus dipasang ulang.**
> Menu itu disimpan di sisi Telegram, bukan dibaca dari kode — buka
> `https://<domain>/api/admin/setup?secret=<TELEGRAM_WEBHOOK_SECRET>` sekali, lalu
> tutup-buka aplikasi Telegram (klien meng-cache daftarnya). Command yang belum
> terdaftar TETAP BEKERJA kalau diketik manual; ia hanya tidak muncul di saran
> pengetikan — kegagalan yang tidak menimbulkan error dan karena itu mudah lolos.

Mulai dari `/series`. Nama grup hanya tertulis di browser tree Revit — di PC —
sementara yang meminta gambarnya sedang memegang HP; tanpa command itu, `--series`
hanya bisa dipakai orang yang sudah duduk di depan Revit, yaitu justru orang yang
tidak butuh bot. Ia juga muncul di menu `/` Telegram, jadi bisa DITEKAN: tidak ada
tanda hubung yang bisa diubah autocorrect. Alias: `/seri`, `/grup`.
`/sheets --groups` masih bekerja dan mendelegasi ke command yang sama.

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

## Satu Revit, beberapa file terbuka

```bash
/project                # tombol pilih dari file yang sedang terbuka
/project WAREHOUSE      # pilih langsung tanpa menekan tombol
```

Pilihannya melekat **per user**: kamu bisa bekerja di project A sementara orang
lain di project B, pada satu Revit yang sama. Tanpa pilihan, semua command ikut
dokumen yang sedang aktif di layar — perilaku sebelum fitur ini ada.

Kenapa ini bukan sekadar kenyamanan: sebelumnya orang yang duduk di depan PC
menentukan project siapa pun yang mengirim perintah dari HP — tanpa tahu ia
sedang menentukannya, dan si pengirim tidak punya cara melihat maupun
mengubahnya. Lebih buruk, job yang dibekukan ke project A akan DITOLAK
("Model tidak cocok") kalau ia kebetulan pindah tab sebelum Revit mengambilnya.

Job sekarang mencari dokumennya berdasarkan judul di antara SEMUA yang terbuka.
Tidak ada dokumen yang diaktifkan diam-diam — layar orang di depan Revit tidak
disentuh. Project yang sudah ditutup TIDAK jatuh ke dokumen terdekat: ia dijawab
dengan daftar yang ada, karena mengerjakan project yang salah menghasilkan gambar
kerja yang terlihat benar.

**Butuh migrasi `004_project_selection.sql`**, dijalankan sekali di Supabase SQL
Editor. Kalau belum dijalankan bot tetap bekerja seperti sebelumnya dan `/project`
mengatakan apa yang kurang — server memeriksa kolomnya lebih dulu, sebab kolom
yang belum ada membuat PostgREST menolak SELURUH request, dan yang mati bukan
cuma fiturnya melainkan heartbeat.

---

## Rekap elemen: chat, atau CSV

```bash
/count GROUND FLOOR                      # rekap 8 kategori MEP
/count GROUND FLOOR lighting --detail    # pecah per nama type, di dalam chat
/count GROUND FLOOR --csv                # berkas: + ruangan, beban, circuit
/tray GROUND FLOOR                       # per Comments (LV LADDER, dst)
/tray GROUND FLOOR --type                # per nama type Revit
```

`--detail` untuk **cable tray** menyebut panjang meter per type, bukan jumlah
batang. Jumlah batang tidak berarti apa-apa di lapangan — satu segmen bisa 60 cm
atau 3 m — dan baris kategorinya sudah menyebut meter, jadi rincian yang hanya
menyebut jumlah membuat dua angka yang tidak bisa dijumlahkan menjadi satu.

`--csv` keluar sebagai **berkas**, bukan pesan, dan itu bukan pilihan gaya:
`Layout.Width` adalah 52 karakter — diukur dari blok kode Telegram di ponsel —
sementara tabel enam kolom butuh sekitar 65 sebelum spasi antar kolom dihitung.
Kolomnya mengikuti schedule Revit supaya bisa dibandingkan baris per baris:

```
KATEGORI, FAMILY & TYPE, LEVEL, RUANGAN, COUNT,
APPARENT LOAD (VA), VA/UNIT, CIRCUIT NUMBER, PANJANG (m)
```

Tiga hal yang ikut disebut di chat, dan semuanya soal kepercayaan pada angkanya:

- **Sumber ruangan** — `FamilyInstance.Room`, `Space`, atau `GetRoomAtPoint`.
  Ketiganya dicoba berurutan karena tidak ada satu yang benar untuk semua model,
  dan kolom kosong untuk separuh model tidak boleh terlihat seperti "elemennya
  memang tidak di ruangan mana pun".
- **Sumber beban** — `Electrical Data` atau `Apparent Load`. Logikanya satu,
  dipakai bersama `/load` (`ElectricalLoad.cs`): dua salinan berarti dua angka VA
  berbeda untuk elemen yang sama, dan yang salah tidak akan terlihat salah.
- **Berapa elemen tanpa nilai** — selnya **dikosongkan**, bukan diisi `0`. Nol
  berarti "diukur, hasilnya nol"; kosong berarti "tidak ada nilainya di model".

**Validasi sekali di awal:** bandingkan CSV-nya dengan schedule yang sudah ada di
Revit. Kalau angkanya sama persis, logika filter dan levelnya benar dan hasil
berikutnya bisa dipercaya.

CSV memakai koma sebagai pemisah dan titik sebagai desimal, sama dengan
`/schedule`. Kalau Excel-mu memakai locale yang membaca koma sebagai desimal,
yang perlu diubah adalah **kedua** tempat sekaligus — dua konvensi CSV di satu
bot lebih membingungkan daripada satu konvensi yang salah.

---

## Daftarkan PC Revit dari panel

Sebelum ini machine token hanya bisa satu: `MACHINE_TOKEN` di Environment
Variables Vercel. Sekarang PC bisa didaftarkan sebagai **baris tabel** — admin
menekan tombol di panel, server yang membuat tokennya, dan berlakunya seketika.

Kenapa bukan env var, dan ini yang menentukan seluruh bentuknya:

| Lewat env var | Lewat tabel |
|---|---|
| Mengubahnya butuh **redeploy** | Berlaku seketika |
| `MACHINE_TOKEN_1/_2/_3` → kode harus tahu ada berapa | Tambah baris, kode tidak berubah |
| Mencabut satu PC = hapus env + redeploy | Satu tombol, tanpa menyentuh PC lain |

Batasnya: **env untuk konfigurasi** (satu nilai, jarang berubah), **tabel untuk
data** (bertambah, berkurang, dicabut). Daftar PC adalah data, sama seperti
`bot_users` — yang sudah menempuh perpindahan yang sama dari SQL manual ke panel.

Yang tersimpan cuma **SHA-256** tokennya, jadi token ditampilkan **sekali** lalu
tidak bisa dilihat lagi. Yang hilang diganti, bukan dipulihkan.

`MACHINE_TOKEN` **tetap berlaku** sebagai jalur cadangan untuk PC yang sudah
berjalan, dan urutan itu disengaja: membuang env-nya sebelum PC yang ada
dipindahkan ke tabel membuat satu-satunya PC yang ada langsung dijawab 401 — dan
karena add-in hanya mencatatnya di berkas log di PC itu, yang terlihat dari
Telegram cuma "PC offline" untuk PC yang justru menyala.

**Butuh migrasi `005_machines.sql`.** Kalau belum dijalankan, bot bekerja persis
seperti sebelumnya lewat `MACHINE_TOKEN`, dan panel **mengatakan** apa yang
kurang alih-alih hanya mematikan tombolnya.

---

## Setiap user pakai Revit di PC-nya sendiri

Job diarahkan ke **PC pemiliknya**. Rantainya:

```
chat_id (dari Telegram, tidak bisa dipalsukan)
   ↓
bot_users.machine_id      ← admin memasangkannya lewat panel
   ↓
commands.machine_id       ← dibekukan saat job dibuat
   ↓
hanya PC itu yang mengklaimnya
```

### Tiga keadaan, dan tidak satu pun jadi jurang

| PC terdaftar | Yang terjadi |
|---|---|
| **0** | Perilaku lama sepenuhnya. Semua dibaca dari `machine_state`, job tidak dialamatkan |
| **1** | Semua job ke PC itu — **tanpa perlu satu penugasan pun diisi**. Tidak ada yang bisa salah pilih, jadi tidak ada yang perlu dipilih |
| **≥2** | User dengan penugasan dapat PC-nya. User **tanpa** penugasan **ditolak dengan kalimat** beserta daftar PC yang ada |

Keadaan ketiga itu yang paling penting, dan penolakannya disengaja: menebak
salah satu PC berarti mengerjakan model orang lain lalu mengirimkannya sebagai
hasil yang sah — dan tidak ada apa pun di balasannya yang akan menandai bahwa
angka atau gambar kerja itu dari project yang salah. Penjagaan `expectedDocTitle`
di add-in pun **lolos** kalau judul modelnya kebetulan sama.

Keadaan kedua itu yang membuat pemasangan tidak punya langkah "sekarang semuanya
berhenti sampai admin menugaskan semua orang".

### Yang jadi per-PC, dan yang tetap global

| Per-PC | Global |
|---|---|
| Online / terakhir terlihat | `bot_enabled` — kill switch semua PC sekaligus |
| `/pause` `/resume` | Kedaluwarsa job (`expires_at`) |
| Model terbuka + `/project` | |
| `/status` `/queue` | |
| Penyapuan job mati | |

**`/pause` hanya menghentikan PC pengirimnya.** Menghentikan Revit orang lain
dari HP tanpa mereka tahu adalah kejutan yang tidak bisa dijelaskan dari sisi
mereka: job tetap masuk antrean dan tidak pernah jalan.

**Penyapuan wajib per-PC**, dan ini kegagalan termahal kalau dilewat: `/claim`
dari PC yang idle melaporkan `busy: false`. Tanpa pembatasan, itu terbaca sebagai
"tidak ada yang mengerjakan job apa pun" — lalu export 25 sheet di PC lain
ditutup sebagai terlantar, tepat sebelum hasilnya tiba.

### `for update skip locked` ternyata tidak perlu

`docs/CATATAN-ARSITEKTUR.md` §11 dan komentar lama di `db.claimNextCommand`
menyebutnya sebagai keharusan untuk PC kedua. Untuk topologi ini **tidak**: satu
user dipasangkan ke tepat satu PC, dan setiap PC hanya melihat job yang
dialamatkan kepadanya — jadi dua PC tidak akan pernah memperebutkan baris yang
sama. Trik "PATCH dengan filter `status=pending`" yang sudah ada tetap cukup, dan
masih berguna untuk satu kasus yang tersisa: satu PC dengan dua sesi Revit.

### Urutan pemasangan — jangan dibalik

```
1. Daftarkan PC yang SUDAH berjalan (PC admin) di panel
2. Pasang tokennya:  .\set-token.ps1 -Token "…"   → TUTUP & BUKA Revit
3. Pastikan ia hijau di panel  ← bukti tokennya benar-benar dipakai
4. Baru tambah PC user berikutnya, satu per satu
5. Setelah ada PC kedua: pasangkan tiap user ke PC-nya di bagian User
```

Langkah 3 tidak boleh dilewat. `MACHINE_TOKEN` masih berlaku sebagai jalur
cadangan, jadi PC admin **tetap jalan** walau langkah 2 belum dikerjakan — tapi
lewat jalur itu ia tidak punya identitas, dan job yang dialamatkan ke baris
"PC Admin" tidak akan pernah diambil siapa pun. Panel yang menampilkannya
"belum pernah terlihat" adalah tanda bahwa langkah 2 masih tertunda.

**Butuh migrasi `006_machine_routing.sql`.** Kalau belum dijalankan, bot bekerja
persis seperti sebelumnya — satu antrean, dilayani PC mana pun.

---

## `/active` — melihat project lintas PC, tanpa bisa menyentuhnya

User yang **tidak punya Revit sama sekali** (cuma HP) bisa memakai bot tanpa
token, tanpa add-in, tanpa menginstal apa pun: token itu milik **PC**, identitas
user adalah `chat_id`. Admin cukup menambahkannya di panel.

Yang `/active` (alias `/aktif`) tambahkan: ia bisa **melihat** project yang
sedang terbuka di PC-PC lain, tanpa bisa mengirim perintah ke sana.

```
📂 Project yang sedang terbuka

› PC Budi · 🟢 2 menit lalu          ← › = PC yang melayanimu
     ● GEDUNG-A.rvt

  PC Andi · 🟢 4 detik lalu
     ● GEDUNG-B.rvt
     ○ LAMPIRAN-MEP.rvt

  PC Sari · 🔴 offline sejak 18:42
     ● WAREHOUSE.rvt

● sedang di layar · ○ terbuka juga
Butuh yang lain? Minta admin memindahkanmu — sebut nama PC-nya.
```

### Melihat ≠ memakai, dan ongkosnya jauh berbeda

| | Yang terjadi | Akibat ke pemilik PC |
|---|---|---|
| **`/active`** | Membaca `machines.open_docs` dari database | **Nol.** Revit tidak disentuh sedetik pun |
| **`/count`, `/pdf`** | Job masuk antrean PC itu | `/pdf` membekukan Revit-nya 2–5 menit |

Itu sebabnya `/active` murah dan boleh dibuka luas, sementara **mengirim
perintah tetap lewat admin**: job selalu menuju `bot_users.machine_id`, dan
hanya admin yang bisa mengubahnya. Melihat daftar tidak memindahkan tujuan
perintah siapa pun.

Datanya sudah ada — `open_docs` dikirim add-in di **setiap heartbeat, tiap 4
detik** — jadi fitur ini **tidak menyentuh add-in sama sekali**. Tidak ada DLL
yang perlu dibangun ulang, tidak ada PC yang perlu didatangi.

### Admin yang menentukan PC mana yang boleh terlihat

Panel → **PC Revit** → tombol `pribadi` / `dibagikan` per PC.

Default **`private`**, dan itu disengaja: nama berkas model mengungkap nama
project, dan nama project sering mengungkap nama klien. Default `shared` berarti
menjalankan migrasinya langsung membuka daftar itu ke semua orang tanpa satu pun
keputusan diambil — dan tidak ada yang akan menyadarinya.

`/active` juga bekerja untuk user yang **belum dipasangkan** ke PC mana pun. Itu
justru gunanya di keadaan paling membingungkan: ia bisa melihat apa yang ada,
lalu menyebut PC yang ia butuh — alih-alih menebak.

**Butuh migrasi `007_machine_sharing.sql`.** Tanpa itu `/active` hanya
menampilkan PC milik user itu sendiri, dan panel mengatakan apa yang kurang.

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
npm run check     # enam pemeriksaan, berhenti di yang pertama gagal
```

| Pemeriksaan | Yang dijaga |
|---|---|
| `typecheck` | root + `api/` |
| `check:i18n` | katalog ID/EN: key, placeholder, batas panjang Telegram |
| `check:commands` | daftar command panel web ↔ server, termasuk penanda "belum jalan" |
| `check:runtime` | format modul fungsi Vercel — kalau menyimpang, SEMUA endpoint mati |
| `check:addin` | sumber C# add-in: byte NUL, kurung tidak berimbang, `using` yang hilang. BUKAN compiler — yang menentukan tetap workflow `addin` |
| `simulate` | seluruh jalur hasil job di atas Supabase + Telegram tiruan |

Keenamnya juga jalan otomatis di GitHub Actions (`.github/workflows/check.yml`).
Semuanya menangkap kerusakan yang TIDAK menimbulkan error saat runtime: key
terjemahan yang hilang diam-diam jatuh ke Bahasa Indonesia, daftar command di
panel yang menyimpang hanya menampilkan lebih sedikit tombol, dan berkas hasil
yang tidak pernah sampai cuma terlihat sebagai "⏳" yang tidak berubah.
