namespace RevitTelegramBridge.Services;

/// <summary>
/// Log berkas sederhana. Add-in tidak punya konsol, dan TaskDialog di dalam
/// loop polling akan membekukan Revit — jadi satu-satunya jejak yang berguna
/// saat ada yang salah adalah berkas ini.
/// </summary>
public static class Log
{
    private static readonly object Gate = new();

    private static string Path => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "RevitTelegramBridge",
        "bridge.log");

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);

    public static void Error(string where, Exception ex) =>
        Write("ERROR", $"{where}: {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}");

    private static void Write(string level, string message)
    {
        try
        {
            lock (Gate)
            {
                var dir = System.IO.Path.GetDirectoryName(Path)!;
                Directory.CreateDirectory(dir);

                // Potong kalau sudah > 5 MB — log yang tumbuh tanpa batas
                // akhirnya jadi masalah sendiri di PC kerja.
                var file = new FileInfo(Path);
                if (file.Exists && file.Length > 5 * 1024 * 1024) File.Delete(Path);

                File.AppendAllText(Path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging tidak boleh menjatuhkan apa pun.
        }
    }
}
