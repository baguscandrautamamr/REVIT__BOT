# Simpan machine token terenkripsi DPAPI.
#
#   Jalankan di Windows PowerShell (bukan PowerShell 7), sekali saja, di PC Revit:
#     .\set-token.ps1 -Token "isi-MACHINE_TOKEN-dari-Vercel"
#
# Hasilnya di %APPDATA%\RevitTelegramBridge\machine.token — terikat ke akun
# Windows yang menjalankannya. Disalin ke PC lain, berkas itu tidak bisa dibuka.
# Token TIDAK pernah masuk ke dalam DLL: string di dalam DLL terbaca dengan
# editor teks biasa oleh siapa pun yang bisa menyalin berkasnya.

param(
    [Parameter(Mandatory = $true)]
    [string]$Token
)

Add-Type -AssemblyName System.Security

$dir = Join-Path $env:APPDATA 'RevitTelegramBridge'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$path    = Join-Path $dir 'machine.token'
$entropy = [System.Text.Encoding]::UTF8.GetBytes('RevitTelegramBridge/v1')
$plain   = [System.Text.Encoding]::UTF8.GetBytes($Token)

$cipher = [System.Security.Cryptography.ProtectedData]::Protect(
    $plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)

[System.IO.File]::WriteAllBytes($path, $cipher)

Write-Host "Token tersimpan di $path" -ForegroundColor Green
Write-Host "Tutup dan buka lagi Revit supaya add-in membacanya."
