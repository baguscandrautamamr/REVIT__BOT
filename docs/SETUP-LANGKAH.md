# Langkah Setup — dari nol sampai bot menjawab

Semua langkah di sini bisa dikerjakan **lewat browser dan dashboard saja** —
tidak perlu terminal, tidak perlu Git di komputermu. Terminal baru dibutuhkan
di langkah terakhir, saat membangun add-in di PC Revit.

Referensi lengkap tiap topik ada di
[TELEGRAM-BOT-GUIDE.id.md](./TELEGRAM-BOT-GUIDE.id.md); di sini hanya urutan
tindakan.

Contoh domain di bawah: `https://revit-bot.vercel.app` · bot `@revitone_bot`.

---

## Langkah 1 — Vercel sudah men-deploy

Buka di browser:

```
https://revit-bot.vercel.app/api/health
```

| Yang muncul | Artinya |
|---|---|
| JSON `{"ready":…,"missingEnv":[…]}` | Deploy jalan → lanjut Langkah 2 |
| `404: NOT_FOUND` | Deployment belum berlabel Production → lihat di bawah |

**Kalau 404.** Repo ini tidak punya branch `main`; seluruh kode ada di branch
`claude/dual-lang-theme-telegram-guide-oix5c8`. Biasanya bukan masalah — GitHub
menjadikan branch pertama yang di-push sebagai *default branch*, dan Vercel
mengambil Production Branch dari situ. Kalau ternyata belum:

Halaman **Settings → Git di level tim** (ciri: ada tulisan "Manage projects" di
sebelah tiap toggle) tidak memuat setelan ini. Yang kamu butuhkan halaman
**project**:

```
https://vercel.com/<nama-akun>/revit-bot/settings/git
```

1. **Production Branch** — tepat di bawah kotak "Connected Git Repository" —
   isi nama branch di atas → **Save**.
2. Tab **Deployments** → deployment terbaru dari branch itu → `⋯` →
   **Promote to Production** (atau **Redeploy** kalau belum ada).

Domain utama hanya melayani deployment berlabel **Production**; selama masih
Preview, URL-nya tetap 404.

---

## Langkah 2 — Environment variable

Vercel → **Settings → Environment Variables**, semuanya untuk
**Production and Preview**:

| Nama | Isi |
|---|---|
| `SUPABASE_URL` | dari Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | idem. **Server-only** — jangan pernah masuk ke klien |
| `TELEGRAM_BOT_TOKEN` | dari BotFather (`/mybots` → pilih bot → API Token) |
| `TELEGRAM_WEBHOOK_SECRET` | acak, **hanya `A-Z a-z 0-9 _ -`** — lihat peringatan di bawah |
| `MACHINE_TOKEN` | acak. Untuk add-in Revit, **bukan** token bot |
| `PANEL_URL` | `https://revit-bot.vercel.app/panel` |

> ### ⚠️ Jangan pakai base64 untuk `TELEGRAM_WEBHOOK_SECRET`
>
> Telegram hanya menerima **`A-Z a-z 0-9 _ -`** (1–256 karakter) untuk
> `secret_token`. `openssl rand -base64 32` — cara paling umum orang membuat
> string acak — menghasilkan `+`, `/`, dan `=`, dan akibatnya ganda:
>
> 1. `setWebhook` ditolak Telegram, jadi webhook tidak pernah terpasang.
> 2. `+` di query string dibaca browser sebagai **spasi**, jadi
>    `/api/admin/setup?secret=…` menjawab `forbidden` walaupun kamu menyalin
>    secret yang benar.
>
> Gejalanya cuma "bot diam" — tanpa satu pun petunjuk ke arah sini. Kalau
> `/api/health` melaporkan `"webhookSecretFormat": "invalid"`, inilah
> penyebabnya. Yang aman: **`openssl rand -hex 32`**.

### Membuat string acak yang aman

Pilih sesuai yang kamu punya. Ketiganya menghasilkan heksadesimal, jadi selalu
diterima Telegram.

**PowerShell** (tidak ada `openssl` bawaan di Windows):

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
```

Sudah di-clone repo-nya? Cukup `.\scripts\deploy-bot.ps1 -NewSecret`.

**macOS / Linux / Git Bash:**

```bash
openssl rand -hex 32
```

**Browser saja** — konsol (F12) di halaman mana pun:

```js
crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
```

> Jangan pakai `Get-Random` di PowerShell atau `Math.random()` di browser.
> Keduanya bukan generator kriptografis — cukup untuk melempar dadu, tidak
> untuk secret.

Simpan `MACHINE_TOKEN` — nanti dipakai lagi di PC Revit.

> **Setelah menambah env, WAJIB redeploy.** Env hanya terbaca saat deployment
> dibuat; deployment lama tetap memakai nilai lama.
> **Deployments** → `⋯` di deployment teratas → **Redeploy**.

Ulangi Langkah 1 sampai `/api/health` menjawab `"missingEnv": []`.

---

## Langkah 3 — Migrasi database

Supabase → **SQL Editor** → tempel isi `supabase/migrations/001_init.sql` →
**Run**. Lalu ulangi untuk `002_security.sql`.

Yang kedua tidak boleh dilewat. Isinya dua hal:

1. Tabel `tg_updates` — kunci anti-duplikat. Telegram mengirim ulang update
   yang sama kalau webhook telat menjawab; tanpa tabel ini, satu `/pdf` bisa
   jalan dua kali.
2. `enable row level security` di semua tabel, **tanpa policy apa pun.**
   Aplikasi memakai service role key yang melewati RLS, jadi tidak ada yang
   rusak. Tanpa baris itu, siapa pun yang punya anon key — dan anon key memang
   dibagikan ke klien — bisa membaca seluruh `bot_users` beserta chat ID semua
   orang.

Hasil yang benar: `Success. No rows returned`.

---

## Langkah 4 — Pasang webhook + menu, satu URL

Buka di browser, ganti `<SECRET>` dengan isi `TELEGRAM_WEBHOOK_SECRET`:

```
https://revit-bot.vercel.app/api/admin/setup?secret=<SECRET>
```

Satu kunjungan itu mengerjakan semuanya:

- `setWebhook` ke domain tempat endpoint itu sendiri berjalan, lengkap dengan
  `secret_token`, `allowed_updates`, dan `drop_pending_updates`
- menu command: daftar default, daftar `id`, daftar `en`
- menu penuh untuk tiap admin di tabel `bot_users` (masih kosong sekarang —
  itu wajar, lihat Langkah 6)
- deskripsi profil bot dalam dua bahasa
- tombol menu Mini App ke `PANEL_URL`

Balasannya JSON berisi daftar apa saja yang dipasang, plus `warnings` untuk
yang dilewati. Aman dibuka berkali-kali — semuanya menimpa, bukan menambah.

> Endpoint ini dilindungi `TELEGRAM_WEBHOOK_SECRET`. Tanpa itu, siapa pun yang
> menebak URL-nya bisa memindahkan webhook botmu ke server lain.

**Lebih suka PowerShell?** Ada jalur setara yang meng-clone repo ke komputer
dan menjalankan hal yang sama dari sana — lihat
[Lampiran A](#lampiran-a--jalur-powershell). Hasilnya identik; keduanya
memanggil fungsi yang sama.

**Verifikasi** — buka (ganti `<TOKEN>` dengan token bot):

```
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

Yang kamu cari: `"pending_update_count": 0` dan **tidak ada**
`last_error_message`. Kalau ada errornya, itu jawabannya — jangan menebak.

---

## Langkah 5 — Cari tahu chat ID-mu

Kirim apa saja ke `@revitone_bot`, misalnya:

```
/status
```

Balasannya:

```
Kamu belum terdaftar. Minta admin menambahkan chat ID kamu: 123456789
```

Angka itu chat ID-mu. **Kalau bot diam saja**, webhook belum jalan — kembali ke
Langkah 4 dan periksa `getWebhookInfo`.

---

## Langkah 6 — Daftarkan dirimu sebagai admin

Supabase → **SQL Editor**:

```sql
insert into bot_users (chat_id, name, role)
values (123456789, 'Bagus', 'admin');
```

> **`123456789` itu angka contoh — ganti dengan chat ID dari Langkah 5.**
> Dijalankan apa adanya, barisnya terdaftar atas nama chat yang tidak ada dan
> bot tetap menjawab "belum terdaftar" ke kamu. Kalau terlanjur:
> ```sql
> delete from bot_users where chat_id = 123456789;
> ```

Rekan lain ditambahkan dengan cara sama, `role` diisi `'viewer'`.

**Lalu buka lagi URL Langkah 4.** Sekarang tabel `bot_users` sudah berisi
admin, jadi menu command admin ikut terpasang — sebelumnya dilewati karena
belum ada admin untuk dituju.

Terakhir, tutup dan buka lagi aplikasi Telegram: klien meng-cache menu command.

---

## Langkah 7 — Uji dari HP, belum perlu Revit

```
/status
```

Yang **benar** terjadi sekarang:

```
📊 Status

🔴 PC offline sejak —
Model: — (belum ada dokumen terbuka)
Revit: — · add-in —
Antrean: 0 pending, 0 jalan
```

Itu bukan kegagalan — itu **bukti seluruh rantai jalan**: Telegram → Vercel →
Supabase → balik ke Telegram. PC memang offline karena add-in-nya belum ada.

Coba juga:

```
/help          → daftar command sesuai role kamu
/lang en       → semua balasan berikutnya Bahasa Inggris
/lang auto     → kembali ikut bahasa HP
/theme dark    → preferensi tema panel
```

Dan ketuk tombol **Panel** di sebelah kotak ketik untuk membuka Mini App.

> Membuka `revit-bot.vercel.app/panel` langsung di browser akan menampilkan
> panel tanpa data — server menolak dengan 401 karena tidak ada tanda tangan
> `initData` dari Telegram. Itu memang perilakunya, bukan kerusakan.

---

## Langkah 8 — Add-in Revit (di PC Revit)

Ini yang membuat `/status` berubah hijau dan `/count`, `/levels`, `/pdf`
benar-benar bekerja. Langkah ini **butuh terminal** di PC Revit.

**a. Build** — perlu .NET 8 SDK dan Revit 2025 terpasang. **Tutup Revit dulu**,
kalau terbuka DLL-nya terkunci dan build gagal.

```powershell
dotnet build -c Release
```

Build otomatis menyalin `.addin` + DLL ke
`%APPDATA%\Autodesk\Revit\Addins\2025\`. Revit di lokasi lain:

```powershell
dotnet build -c Release -p:RevitDir="D:\Autodesk\Revit 2025\"
```

**b. Pasang machine token** — Windows PowerShell (bukan PowerShell 7), di
folder `addin/`:

```powershell
.\set-token.ps1 -Token "isi-MACHINE_TOKEN-yang-tadi"
```

Token disimpan terenkripsi DPAPI di `%APPDATA%\RevitTelegramBridge\`, terikat
ke akun Windows-mu. Ia **tidak** ada di dalam DLL — DLL bisa disalin siapa saja
yang punya akses ke PC, dan string di dalamnya terbaca dengan Notepad.

**c. Arahkan ke server** (opsional, default sudah `revit-bot.vercel.app`):

```powershell
[Environment]::SetEnvironmentVariable('REVIT_BRIDGE_URL', 'https://revit-bot.vercel.app', 'User')
```

**d. Matikan sleep:**

```powershell
powercfg /change standby-timeout-ac 0
```

PC yang tidur memutus polling walaupun Revit terbuka — dan gejalanya
membingungkan: bot "kadang jalan kadang tidak".

**e. Buka Revit, buka satu model, tunggu ~10 detik.** Lalu dari HP:

```
/status     → 🟢 PC online, nama model muncul
/levels     → daftar level
/count L1   → rekap 8 kategori MEP
```

---

## Langkah 9 — Validasi yang menentukan

Jalankan `/count` sekali, lalu **bandingkan angkanya dengan schedule yang sudah
ada di Revit.**

- **Sama persis** → logika level sudah benar, hasil berikutnya bisa dipercaya.
- **Meleset** → hampir selalu satu dari dua hal:
  1. **Kategori family tidak seperti dugaan.** Banyak family fire alarm
     sebenarnya ter-load sebagai *Electrical Fixtures*. Pilih satu smoke
     detector di Revit, lihat kategorinya di Properties, lalu sesuaikan daftar
     di `addin/Commands/CountByLevelCommand.cs`.
  2. **Elemen di dalam link tidak terhitung.** Itu perilaku Revit
     (`FilteredElementCollector(doc)` tidak menembus link), bukan bug.

Jangan mengundang orang sebelum langkah ini cocok. Angka yang salah lebih
berbahaya daripada bot yang mati — orang mempercayainya.

---

## Urutan mengundang orang

```
1. /status jalan                → rantai terbukti
2. /count + /levels cocok       → angkanya dipercaya
3. /pdf                         → output nyata
   ── pakai sendiri 1 minggu ──
4. undang 1 rekan (role viewer)
5. sisanya sesuai permintaan nyata
```

Jangan undang 5 orang sebelum stabil. Kalau masih ada bug, kamu jadi support
desk sambil memperbaikinya.

---

## Kalau ada yang tidak jalan

**Mulai dari satu URL ini** — ia memeriksa seluruh rantai sekaligus dan
menyebutkan masalahnya dalam kalimat, bukan kode:

```
https://revit-bot.vercel.app/api/admin/diag?secret=<SECRET>
```

Yang dilaporkan: env yang kosong, baris `machine_state`, isi `bot_users`,
validitas token bot, status webhook (`url`, `pending_update_count`,
`last_error_message`), dan keberadaan tabel `tg_updates`. Bagian `problems`
berisi daftar yang perlu diperbaiki; kalau kosong, semuanya benar.

Token bot tidak pernah muncul di URL — dibaca dari env di sisi server.

| Gejala | Cek pertama |
|---|---|
| **Bot diam total** | `/api/admin/diag` → bagian `webhook.url`. Kosong = belum dipasang |
| Semua URL 404 | Langkah 1 — deployment belum Production |
| `/api/health` → `missingEnv` terisi | Langkah 2, lalu **redeploy** |
| Panel tampil polos tanpa warna | Aset CSS 404 — pastikan deployment memakai commit terbaru |
| Bot diam total | `getWebhookInfo` → `last_error_message` |
| `/api/admin/setup` → `forbidden` | `secret` di URL tidak sama dengan `TELEGRAM_WEBHOOK_SECRET` |
| "kamu belum terdaftar" terus | Langkah 6 — baris di `bot_users` |
| Menu `/` kosong / bahasa lama | Buka ulang URL Langkah 4, lalu restart Telegram |
| Command admin tidak muncul di menu | Buka ulang URL Langkah 4 **setelah** baris admin ada |
| `/status` tetap 🔴 padahal Revit terbuka | `%APPDATA%\RevitTelegramBridge\bridge.log` |
| Panel 401 di browser | Memang begitu — buka dari dalam Telegram |

Daftar lengkap: [TELEGRAM-BOT-GUIDE.id.md §16](./TELEGRAM-BOT-GUIDE.id.md#16-troubleshooting).

---

## Lampiran A — Jalur PowerShell

Pengganti Langkah 4 dan Langkah 6, untuk yang lebih suka menjalankan dari
komputer sendiri. Berguna juga karena PC yang sama nanti dipakai membangun
add-in di Langkah 8.

### Prasyarat (sekali saja)

| Perlu | Unduh |
|---|---|
| Git untuk Windows | <https://git-scm.com/download/win> |
| Node.js LTS | <https://nodejs.org> |

Tutup dan buka lagi PowerShell setelah memasang keduanya, supaya `PATH`
terbaca.

### Clone dan deploy

```powershell
# 1. Ambil repo ke folder mana pun
cd $env:USERPROFILE
git clone https://github.com/baguscandrautamamr/REVIT__BOT.git
cd REVIT__BOT

# 2. Jalankan
.\scripts\deploy-bot.ps1
```

Skrip itu mengerjakan, berurutan: cek prasyarat → `git clone`/`git pull` →
`npm ci` → tanya kredensial → pasang webhook + menu dua bahasa + deskripsi +
tombol panel → verifikasi lewat `getWebhookInfo` dan menampilkan hasilnya.

Kalau PowerShell menolak menjalankan skrip:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Berlaku hanya untuk jendela itu, dan hilang saat ditutup — lebih sempit
daripada mengubah kebijakan seluruh sistem.

### Membuat secret yang valid

```powershell
.\scripts\deploy-bot.ps1 -NewSecret
```

Menghasilkan 64 karakter heksadesimal — selalu diterima Telegram, selalu aman
di URL. Pasang di Vercel, **Redeploy**, baru jalankan skripnya lagi.

### Menjalankan ulang

```powershell
.\scripts\deploy-bot.ps1 -SkipClone
```

`-SkipClone` melewati git dan langsung deploy dari folder yang ada. Ini yang
kamu pakai di Langkah 6, setelah barismu masuk ke `bot_users`.

### Kenapa kredensial ditanya lewat prompt, bukan parameter

PowerShell menyimpan setiap baris perintah ke
`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`
sebagai teks biasa. Token yang diketik sebagai parameter tertinggal di sana
selamanya, terbaca siapa pun yang bisa membuka berkas itu. Yang diketik di
prompt tidak masuk riwayat.

---

## Catatan jujur soal add-in

Kode di `addin/` ditulis lengkap tapi **belum pernah dikompilasi terhadap
`RevitAPI.dll` asli** — tidak ada Revit di lingkungan tempat kode ini dibuat.
Yang paling mungkin butuh penyesuaian saat build pertama:

- Nama properti `PDFExportOptions` (`HideScopeBoxes`, `MaskCoincidentLines`,
  `ColorDepth`, …) — kalau ada yang tidak dikenal, cocokkan dengan
  `RevitAPI.chm`, jangan menebak.
- `ViewSheet.GetAllRevisionIds()` — pastikan urutannya memang kronologis di
  versi 2025.
- Properti `ViewScheduleExportOptions` (`ColumnHeaders`, `HeadersFootersBlanks`)
  — sama seperti di atas, cocokkan dengan `RevitAPI.chm`.
- Versi `System.Text.Json` bisa bentrok dengan yang sudah dimuat Revit. Kalau
  itu terjadi, hapus `PackageReference`-nya — .NET 8 sudah membawa
  `System.Text.Json` di runtime.

Delapan command sudah ada: `/levels`, `/sheets`, `/warnings`, `/count`,
`/tray`, `/find`, `/pdf`, `/schedule`. Sisanya tinggal menambah satu berkas di
`addin/Commands/` dan mendaftarkannya di `CommandHandler` — alasan masing-masing
belum dikerjakan ada di tabel README. Server-nya sudah siap menerima semuanya:
command yang belum ada di add-in dijawab "belum diimplementasi", bukan
menggantung.

Yang perlu dicek di modelmu sendiri, karena tidak ada cara menebaknya dari luar:

- `CountByLevelCommand.Categories` — banyak family fire alarm sebenarnya
  ter-load sebagai Electrical Fixtures. Kategori yang meleset melaporkan 0
  tanpa terlihat salah.
- `TrayCommand.GroupKeyOf` — mengelompokkan cable tray dari parameter Comments.
  Kalau jenis tray di modelmu ditulis di parameter lain, itu satu-satunya
  tempat yang perlu diubah.
