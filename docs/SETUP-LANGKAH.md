# Langkah Setup — dari posisi kamu sekarang

Panduan ini melanjutkan dari apa yang sudah kamu kerjakan. Referensi lengkap
tiap topik ada di [TELEGRAM-BOT-GUIDE.id.md](./TELEGRAM-BOT-GUIDE.id.md);
di sini hanya urutan tindakan.

Domain kamu: `https://revit-bot.vercel.app` · Bot: `@revitone_bot`

---

## Yang sudah beres

| ✅ | Catatan |
|---|---|
| Project Vercel dibuat | `revit-bot.vercel.app` |
| Tabel Supabase dibuat | `bot_users`, `commands`, `machine_state` — sesuai `001_init.sql` |
| Bot Telegram dibuat | `@revitone_bot` |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` di Vercel | Sudah ada, ditandai Sensitive — sudah benar |

**Satu koreksi kecil:** halaman *URL Configuration* (Site URL / Redirect URLs)
di Supabase itu untuk **Supabase Auth**. Bot ini tidak memakai Supabase Auth
sama sekali — login user ditangani Telegram. Isinya tidak mengganggu, tapi
tidak dipakai. Tidak perlu diutak-atik lagi.

---

## Langkah 0 — Vercel harus punya kode untuk di-deploy

Ini yang paling penting dan paling mudah terlewat: **repo GitHub-mu belum punya
branch `main`.** Seluruh kode ada di branch `claude/dual-lang-theme-telegram-guide-oix5c8`.
Selama Vercel menunggu branch produksi yang belum ada, tidak ada apa pun yang
ter-deploy — dan setiap URL akan 404.

Pilih salah satu:

**A. Jadikan branch ini sebagai `main`** (paling rapi)

```bash
git checkout -b main claude/dual-lang-theme-telegram-guide-oix5c8
git push -u origin main
```
Lalu di GitHub: **Settings → Branches → Default branch** → `main`.

**B. Arahkan Vercel ke branch yang ada**

Vercel → project → **Settings → Git → Production Branch** →
isi `claude/dual-lang-theme-telegram-guide-oix5c8` → **Save** → **Redeploy**.

---

## Langkah 1 — Lengkapi environment variable

Di Vercel baru ada dua. Yang kurang **empat**. Tambah lewat
**Settings → Environment Variables**, pilih **Production and Preview**:

| Nama | Isi | Dari mana |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `123456789:AAF…` | Pesan dari BotFather saat `/newbot`. Kalau hilang: `/mybots` → pilih bot → **API Token** |
| `TELEGRAM_WEBHOOK_SECRET` | string acak | Buat sendiri, lihat di bawah |
| `MACHINE_TOKEN` | string acak | Buat sendiri. Ini yang dipakai add-in Revit, bukan token bot |
| `PANEL_URL` | `https://revit-bot.vercel.app/panel` | Untuk tombol Mini App |

Membuat dua token acak — jalankan di terminal mana saja:

```bash
# TELEGRAM_WEBHOOK_SECRET  (hanya A-Z a-z 0-9 _ - yang diizinkan Telegram)
openssl rand -hex 32

# MACHINE_TOKEN
openssl rand -hex 32
```

Simpan `MACHINE_TOKEN` di tempat aman — nanti dipakai lagi di PC Revit.

> **Setelah menambah env, WAJIB redeploy.** Environment variable hanya terbaca
> saat build/boot; deployment lama tetap memakai nilai lama.
> Vercel → **Deployments** → titik tiga di deployment terbaru → **Redeploy**.

---

## Langkah 2 — Jalankan migrasi kedua

Tabelmu sudah sesuai `001_init.sql`. Ada satu migrasi lagi yang **tidak boleh
dilewat**, karena menyangkut keamanan.

Supabase → **SQL Editor** → tempel isi `supabase/migrations/002_security.sql`
→ **Run**. Isinya dua hal:

1. Tabel `tg_updates` — kunci anti-duplikat. Telegram mengirim ulang update
   yang sama kalau webhook telat menjawab; tanpa tabel ini, satu `/pdf` bisa
   jalan dua kali.
2. `enable row level security` untuk semua tabel, **tanpa policy apa pun.**
   Aplikasi memakai service role key yang melewati RLS, jadi tidak ada yang
   rusak. Tapi tanpa baris ini, siapa pun yang punya anon key — dan anon key
   memang dibagikan ke klien — bisa membaca seluruh isi `bot_users` beserta
   chat ID semua orang.

---

## Langkah 3 — Daftarkan dirimu sebagai admin

Selama belum ada baris di `bot_users`, bot akan menjawab "kamu belum terdaftar"
ke siapa pun, termasuk kamu.

Cara tahu chat ID sendiri: kirim `/status` ke `@revitone_bot`. Balasannya
menyertakan angka chat ID-mu. (Kalau bot belum menjawab sama sekali, lanjut
dulu ke Langkah 4, baru kembali ke sini.)

Supabase → **SQL Editor**:

```sql
insert into bot_users (chat_id, name, role)
values (123456789, 'Bagus', 'admin');
```

Ganti `123456789` dengan chat ID-mu. Rekan lain ditambahkan dengan cara yang
sama, `role` diisi `'viewer'`.

---

## Langkah 4 — Pasang webhook

Ganti dua nilai di bawah dengan milikmu, lalu jalankan:

```bash
export TG_TOKEN="123456789:AAF…"
export TG_SECRET="hasil-openssl-tadi"

curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{
    \"url\": \"https://revit-bot.vercel.app/api/telegram/webhook\",
    \"secret_token\": \"$TG_SECRET\",
    \"allowed_updates\": [\"message\", \"callback_query\"],
    \"drop_pending_updates\": true,
    \"max_connections\": 20
  }"
```

Periksa hasilnya:

```bash
curl "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo"
```

Yang kamu cari: `"pending_update_count": 0` dan **tidak ada**
`last_error_message`. Kalau ada errornya, itu jawabannya — jangan menebak.

---

## Langkah 5 — Cek kesiapan sebelum menguji dari HP

Buka di browser:

```
https://revit-bot.vercel.app/api/health
```

Balasannya menyebut env mana yang masih kosong (hanya **nama**-nya, tidak
pernah nilainya) dan apakah database terhubung:

```jsonc
{ "ready": true, "missingEnv": [], "database": "ok" }
```

Kalau `ready: false`, perbaiki dulu di sini. Menguji dari Telegram sebelum
langkah ini hijau cuma membuang waktu — kamu akan menebak-nebak apakah
masalahnya di env, database, atau Telegram.

---

## Langkah 6 — Pasang menu command dua bahasa

Di komputermu, di dalam folder repo:

```bash
npm install

TELEGRAM_BOT_TOKEN="123456789:AAF…" \
ADMIN_CHAT_IDS="123456789" \
npm run set-commands
```

Ini memasang: menu default (Inggris), menu `id`, menu `en`, plus menu penuh
berisi command admin **hanya untuk chat ID yang kamu sebut**. Sekalian
deskripsi bot di profil, dalam dua bahasa.

Setelah itu tutup dan buka lagi Telegram — klien meng-cache menu command.

---

## Langkah 7 — Uji dari HP (belum perlu Revit)

Kirim ke `@revitone_bot`:

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
Supabase → balik ke Telegram. PC memang offline karena add-in-nya belum
dipasang.

Coba juga:

```
/help          → daftar command sesuai role kamu
/lang en       → semua balasan berikutnya Bahasa Inggris
/lang auto     → kembali ikut bahasa HP
/theme dark    → preferensi tema panel
```

---

## Langkah 8 — Tombol panel (Mini App)

BotFather → `/mybots` → `@revitone_bot` → **Bot Settings** → **Menu Button** →
**Configure menu button** → kirim URL:

```
https://revit-bot.vercel.app/panel
```

Lalu beri nama tombolnya, misalnya `Panel`.

Panel hanya bisa dibuka dari dalam Telegram: server memverifikasi tanda tangan
HMAC `initData`. Membuka URL-nya langsung di browser akan menghasilkan 401 —
itu memang perilakunya.

---

## Langkah 9 — Add-in Revit (di PC Revit)

Ini yang membuat `/status` berubah jadi hijau dan `/count`, `/levels`, `/pdf`
benar-benar bekerja.

**a. Build**

Butuh .NET 8 SDK dan Revit 2025 terpasang. Di folder `addin/`:

```powershell
dotnet build -c Release
```

Build otomatis menyalin `.addin` + DLL ke
`%APPDATA%\Autodesk\Revit\Addins\2025\`. **Tutup Revit dulu** — kalau terbuka,
DLL-nya terkunci dan build gagal.

Kalau Revit terpasang di lokasi lain:

```powershell
dotnet build -c Release -p:RevitDir="D:\Autodesk\Revit 2025\"
```

**b. Pasang machine token**

Di Windows PowerShell (bukan PowerShell 7), di folder `addin/`:

```powershell
.\set-token.ps1 -Token "isi-MACHINE_TOKEN-yang-tadi"
```

Token disimpan terenkripsi DPAPI di `%APPDATA%\RevitTelegramBridge\`, terikat
ke akun Windows-mu. Ia **tidak** ada di dalam DLL — DLL bisa disalin siapa saja
yang punya akses ke PC, dan string di dalamnya terbaca dengan Notepad.

**c. Arahkan add-in ke server** (kalau domainmu berubah)

```powershell
[Environment]::SetEnvironmentVariable('REVIT_BRIDGE_URL', 'https://revit-bot.vercel.app', 'User')
```

Default-nya sudah `https://revit-bot.vercel.app`, jadi langkah ini opsional.

**d. Matikan sleep**

```powershell
powercfg /change standby-timeout-ac 0
```

PC yang tidur memutus polling walaupun Revit terbuka — dan gejalanya
membingungkan: bot "kadang jalan kadang tidak".

**e. Buka Revit, buka satu model, tunggu ~10 detik**

Lalu dari HP:

```
/status     → 🟢 PC online, nama model muncul
/levels     → daftar level
/count L1   → rekap 8 kategori MEP
```

---

## Langkah 10 — Validasi yang menentukan

Jalankan `/count` sekali, lalu **bandingkan angkanya dengan schedule yang sudah
ada di Revit.**

- Angka **sama persis** → logika level sudah benar, hasil berikutnya bisa
  dipercaya.
- Angka **meleset** → hampir selalu satu dari dua hal:
  1. **Kategori family tidak seperti dugaan.** Banyak family fire alarm
     sebenarnya ter-load sebagai *Electrical Fixtures*. Pilih satu smoke
     detector di Revit, lihat kategorinya di Properties, lalu sesuaikan daftar
     di `addin/Commands/CountByLevelCommand.cs`.
  2. **Elemen di dalam link tidak terhitung.** Itu perilaku Revit
     (`FilteredElementCollector(doc)` tidak menembus link), bukan bug.

Jangan lanjut mengundang orang sebelum langkah ini cocok. Angka yang salah
lebih berbahaya daripada bot yang mati — orang mempercayainya.

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

| Gejala | Cek pertama |
|---|---|
| Semua URL 404 | Langkah 0 — branch produksi Vercel |
| `/api/health` → `missingEnv` terisi | Langkah 1, lalu **redeploy** |
| Bot diam total | `getWebhookInfo` → `last_error_message` |
| "kamu belum terdaftar" terus | Langkah 3 — baris di `bot_users` |
| Menu `/` kosong / bahasa lama | Langkah 6, lalu restart Telegram |
| `/status` tetap 🔴 padahal Revit terbuka | `%APPDATA%\RevitTelegramBridge\bridge.log` |
| Panel 401 | Memang begitu di browser biasa — buka dari Telegram |

Daftar lengkap: [TELEGRAM-BOT-GUIDE.id.md §16](./TELEGRAM-BOT-GUIDE.id.md#16-troubleshooting).

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
- Versi `System.Text.Json` bisa bentrok dengan yang sudah dimuat Revit. Kalau
  itu terjadi, hapus `PackageReference`-nya — .NET 8 sudah membawa
  `System.Text.Json` di runtime.

Empat command sudah ada: `/levels`, `/sheets`, `/count`, `/pdf`. Sisanya
(`/tray`, `/panel`, `/find`, `/load`, `/png`, `/schedule`, `/warnings`) tinggal
menambah satu berkas di `addin/Commands/` dan mendaftarkannya di
`CommandHandler`. Server-nya sudah siap menerima semuanya — command yang belum
ada di add-in akan dijawab "belum diimplementasi", bukan menggantung.
