using System.Security.Cryptography;
using System.Text;

namespace RevitTelegramBridge.Services;

/// <summary>
/// Penyimpanan machine token.
///
/// Token TIDAK boleh ada di dalam DLL: DLL bisa disalin siapa saja yang punya
/// akses ke PC, dan string di dalamnya terbaca dengan editor teks biasa.
/// DPAPI mengikat cipher-text ke akun Windows — file yang disalin ke PC lain
/// jadi sampah yang tidak bisa dibuka.
/// </summary>
public static class TokenStore
{
    private static string Path => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "RevitTelegramBridge",
        "machine.token");

    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("RevitTelegramBridge/v1");

    public static string? Load()
    {
        try
        {
            if (!File.Exists(Path)) return null;
            var protectedBytes = File.ReadAllBytes(Path);
            var plain = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception ex)
        {
            // Paling sering: file dibuat oleh akun Windows lain.
            Log.Error("TokenStore.Load", ex);
            return null;
        }
    }

    public static void Save(string token)
    {
        var dir = System.IO.Path.GetDirectoryName(Path)!;
        Directory.CreateDirectory(dir);

        var cipher = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(Path, cipher);
    }
}
