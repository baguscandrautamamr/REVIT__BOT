using System.IO.Compression;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Folder sementara untuk satu export, lalu dibuang.
///
/// Setiap export mendapat foldernya SENDIRI. Itu penting: Revit menentukan nama
/// berkas keluarannya sendiri — ia menempelkan tipe view dan nama view ke nama
/// yang kita minta, dan aturannya berbeda antar format. Satu-satunya cara andal
/// menemukan hasilnya adalah melihat berkas apa yang muncul di folder kosong.
///
/// Dengan folder bersama, cara itu bisa memungut sisa export sebelumnya yang
/// gagal dihapus dan mengirimkannya sebagai "hasil" — PDF sheet yang salah,
/// tanpa satu pun tanda bahwa itu bukan yang diminta.
/// </summary>
internal sealed class ExportWorkspace : IDisposable
{
    public string Folder { get; }

    public ExportWorkspace(string tag)
    {
        Folder = Path.Combine(
            Path.GetTempPath(),
            "RevitTelegramBridge",
            $"{tag}-{Guid.NewGuid():N}"[..(tag.Length + 9)]);
        Directory.CreateDirectory(Folder);
    }

    /// <summary>Berkas hasil, terbaru dulu. Folder ini hanya berisi hasil kita.</summary>
    public FileInfo[] Produced(string extension) =>
        new DirectoryInfo(Folder)
            .GetFiles($"*.{extension.TrimStart('.')}", SearchOption.AllDirectories)
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .ToArray();

    /// <summary>
    /// Satu berkas untuk dikirim: kalau hasilnya lebih dari satu, dibungkus zip.
    ///
    /// Telegram mengirim satu dokumen per pesan, dan tiga DWG yang datang
    /// terpisah tanpa urutan lebih merepotkan daripada satu zip yang jelas.
    /// </summary>
    public (string Name, byte[] Bytes)? Collect(string extension, string zipName)
    {
        var files = Produced(extension);
        if (files.Length == 0) return null;
        if (files.Length == 1) return (files[0].Name, File.ReadAllBytes(files[0].FullName));

        var zipPath = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.zip");
        try
        {
            using (var zip = ZipFile.Open(zipPath, ZipArchiveMode.Create))
            {
                foreach (var file in files) zip.CreateEntryFromFile(file.FullName, file.Name);
            }
            return (zipName, File.ReadAllBytes(zipPath));
        }
        finally
        {
            try { File.Delete(zipPath); } catch { /* %TEMP% dibersihkan Windows */ }
        }
    }

    public void Dispose()
    {
        try { Directory.Delete(Folder, recursive: true); }
        catch (Exception ex) { Services.Log.Warn($"hapus folder export gagal: {ex.Message}"); }
    }

    /// <summary>Nama berkas yang aman dipakai di Windows dan di Telegram.</summary>
    public static string Sanitize(string input)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string(input.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Replace(' ', '_');
    }

    public static string Stamp() => DateTime.Now.ToString("yyyy-MM-dd");
}
