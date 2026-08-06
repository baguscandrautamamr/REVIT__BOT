<#
.SYNOPSIS
    Clone repo dari GitHub, pasang dependensi, lalu deploy konfigurasi ke bot
    Telegram (webhook + menu command dua bahasa + deskripsi + tombol panel).

.DESCRIPTION
    Sekali jalan dari PowerShell di Windows. Tidak menyentuh Vercel maupun
    Supabase — keduanya sudah punya jalurnya sendiri. Yang di-"deploy" di sini
    adalah konfigurasi BOT-nya ke Telegram.

    Rahasia diminta lewat prompt, bukan lewat parameter. Alasannya konkret:
    PowerShell menyimpan setiap baris perintah ke
    %APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt
    dalam bentuk teks biasa. Token yang diketik sebagai parameter akan
    tertinggal di sana selamanya; yang diketik di prompt tidak.

.EXAMPLE
    .\deploy-bot.ps1
    Jalur normal — semua ditanyakan satu per satu.

.EXAMPLE
    .\deploy-bot.ps1 -NewSecret
    Cetak TELEGRAM_WEBHOOK_SECRET baru yang valid untuk Telegram, lalu keluar.

.EXAMPLE
    .\deploy-bot.ps1 -SkipClone
    Lewati git, langsung deploy dari folder yang sudah ada.
#>

[CmdletBinding()]
param(
    [string]$RepoUrl = 'https://github.com/baguscandrautamamr/REVIT__BOT.git',
    [string]$RepoDir = (Join-Path $env:USERPROFILE 'REVIT__BOT'),
    [string]$BaseUrl = 'https://revit-bot.vercel.app',
    [string]$AdminChatIds,
    [switch]$NewSecret,
    [switch]$SkipClone
)

$ErrorActionPreference = 'Stop'

function Write-Step($text)  { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Write-Ok($text)    { Write-Host "  OK  $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "  !   $text" -ForegroundColor Yellow }
function Fail($text)        { Write-Host "`nGAGAL: $text" -ForegroundColor Red; exit 1 }

# ── Mode: cetak secret baru saja ─────────────────────────────────────────────
if ($NewSecret) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    # Heksadesimal, BUKAN base64. Telegram hanya menerima A-Z a-z 0-9 _ -
    # untuk secret_token; base64 menghasilkan + / = dan ditolak.
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })

    Write-Host "`nTELEGRAM_WEBHOOK_SECRET baru:`n" -ForegroundColor Cyan
    Write-Host "  $secret`n"
    Write-Host "Simpan di Vercel -> Settings -> Environment Variables, lalu Redeploy." -ForegroundColor Yellow
    exit 0
}

# ── 1. Prasyarat ─────────────────────────────────────────────────────────────
Write-Step 'Memeriksa prasyarat'

foreach ($tool in @('git', 'node', 'npm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "'$tool' tidak ditemukan. Pasang dulu: git -> https://git-scm.com/download/win , node -> https://nodejs.org (versi LTS)."
    }
}
Write-Ok "git $(git --version | Select-Object -First 1)"
Write-Ok "node $(node --version)"

# ── 2. Ambil kode ────────────────────────────────────────────────────────────
if (-not $SkipClone) {
    Write-Step 'Mengambil kode dari GitHub'

    if (Test-Path (Join-Path $RepoDir '.git')) {
        Write-Host "  Folder sudah ada, menarik perubahan terbaru..."
        git -C $RepoDir pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            Fail "git pull gagal. Kalau ada perubahan lokal yang bentrok, simpan dulu atau hapus folder $RepoDir lalu jalankan lagi."
        }
    }
    else {
        if ((Test-Path $RepoDir) -and (Get-ChildItem $RepoDir -Force | Measure-Object).Count -gt 0) {
            Fail "$RepoDir sudah ada dan tidak kosong, tapi bukan repo git. Pindahkan atau pakai -RepoDir lain."
        }
        git clone $RepoUrl $RepoDir
        if ($LASTEXITCODE -ne 0) { Fail 'git clone gagal. Periksa koneksi dan akses ke repo.' }
    }
    Write-Ok "Kode ada di $RepoDir"
}

if (-not (Test-Path (Join-Path $RepoDir 'package.json'))) {
    Fail "package.json tidak ada di $RepoDir. Salah folder?"
}
Set-Location $RepoDir

# ── 3. Dependensi ────────────────────────────────────────────────────────────
Write-Step 'Memasang dependensi (npm)'
if (Test-Path 'package-lock.json') { npm ci } else { npm install }
if ($LASTEXITCODE -ne 0) { Fail 'npm gagal memasang dependensi.' }
Write-Ok 'Dependensi siap'

# ── 4. Kredensial ────────────────────────────────────────────────────────────
Write-Step 'Kredensial'
Write-Host "  Diketik di sini TIDAK tersimpan di riwayat PowerShell." -ForegroundColor DarkGray

$botToken = Read-Host '  TELEGRAM_BOT_TOKEN (dari BotFather)'
if ([string]::IsNullOrWhiteSpace($botToken)) { Fail 'Token bot wajib diisi.' }

$webhookSecret = Read-Host '  TELEGRAM_WEBHOOK_SECRET (sama persis dengan yang di Vercel)'
if ($webhookSecret -notmatch '^[A-Za-z0-9_-]{1,256}$') {
    Fail @"
Secret mengandung karakter yang ditolak Telegram.
Hanya A-Z a-z 0-9 _ - yang diizinkan (1-256 karakter) - karakter + / = khas
base64 tidak boleh. Buat yang baru:

    .\deploy-bot.ps1 -NewSecret

lalu pasang di Vercel, Redeploy, dan jalankan skrip ini lagi.
"@
}

if (-not $AdminChatIds) {
    Write-Host "  Chat ID didapat dengan mengirim /status ke bot — balasannya menyebut angkamu." -ForegroundColor DarkGray
    $AdminChatIds = Read-Host '  Chat ID admin, pisahkan koma (kosongkan kalau belum tahu)'
}

if ([string]::IsNullOrWhiteSpace($AdminChatIds)) {
    Write-Warn2 'Tanpa chat ID admin, menu command admin dilewati. Jalankan lagi setelah kamu tahu angkanya.'
}
else {
    # Saring lebih awal. Telegram menolak chat ID yang tidak dikenalnya dengan
    # "chat not found", dan angka contoh dari dokumentasi adalah penyebab
    # paling sering.
    $ids = $AdminChatIds -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    foreach ($id in $ids) {
        if ($id -notmatch '^-?\d+$') { Fail "Chat ID '$id' bukan angka." }
        if ($id -eq '123456789') {
            Fail @"
123456789 itu angka CONTOH dari dokumentasi, bukan chat ID-mu.

Cara mendapatkan yang asli:
  1. Kirim /status ke botmu di Telegram.
  2. Balasannya berbunyi "...tambahkan chat ID kamu: <angka>".
  3. Pakai angka itu.

Kalau bot belum menjawab, webhook-nya belum terpasang - jalankan skrip ini
lagi dan kosongkan bagian chat ID admin.
"@
        }
    }
    $AdminChatIds = ($ids -join ',')
}

$panelUrl = "$($BaseUrl.TrimEnd('/'))/panel"

# ── 5. Deploy ke Telegram ────────────────────────────────────────────────────
Write-Step 'Deploy konfigurasi ke Telegram'

$env:TELEGRAM_BOT_TOKEN      = $botToken
$env:TELEGRAM_WEBHOOK_SECRET = $webhookSecret
$env:BASE_URL                = $BaseUrl.TrimEnd('/')
$env:PANEL_URL               = $panelUrl
$env:ADMIN_CHAT_IDS          = $AdminChatIds

try {
    npx tsx scripts/set-commands.ts
    if ($LASTEXITCODE -ne 0) { Fail 'set-commands gagal. Baca pesan di atas.' }
}
finally {
    # Bersihkan dari sesi ini. Variabel proses memang hilang saat jendela
    # ditutup, tapi jangan biarkan tergeletak selama sesi masih hidup.
    Remove-Item Env:TELEGRAM_BOT_TOKEN, Env:TELEGRAM_WEBHOOK_SECRET, `
                Env:BASE_URL, Env:PANEL_URL, Env:ADMIN_CHAT_IDS -ErrorAction SilentlyContinue
}

# ── 6. Verifikasi ────────────────────────────────────────────────────────────
Write-Step 'Verifikasi ke Telegram'

try {
    $info = (Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getWebhookInfo").result

    if ([string]::IsNullOrWhiteSpace($info.url)) {
        Write-Warn2 'Webhook masih kosong.'
    }
    else {
        Write-Ok "webhook  : $($info.url)"
    }
    Write-Ok "antrean  : $($info.pending_update_count) update menunggu"

    if ($info.last_error_message) {
        Write-Warn2 "error terakhir dari Telegram: $($info.last_error_message)"
        Write-Warn2 'Biasanya berarti server membalas non-2xx atau kelamaan menjawab.'
    }
    else {
        Write-Ok 'tidak ada error terakhir'
    }
}
catch {
    Write-Warn2 "Tidak bisa memverifikasi: $($_.Exception.Message)"
}

Write-Host @"

Selesai.

Berikutnya:
  1. Tutup dan buka lagi Telegram - klien meng-cache menu command.
  2. Kirim /status ke botmu. Belum terdaftar? Balasannya menyebut chat ID-mu.
  3. Masukkan chat ID itu ke tabel bot_users di Supabase dengan role 'admin'.
  4. Jalankan skrip ini sekali lagi (boleh pakai -SkipClone) supaya menu
     command admin ikut terpasang.

Untuk add-in Revit, lanjut ke docs/SETUP-LANGKAH.md Langkah 8.
"@ -ForegroundColor Cyan
