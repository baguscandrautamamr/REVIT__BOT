using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /schedule &lt;nama&gt; — export satu schedule ke CSV.
///
/// CSV, bukan PDF: yang diminta orang dari schedule hampir selalu angkanya,
/// untuk ditempel ke Excel. PDF schedule hanya berguna kalau ikut dicetak.
/// </summary>
public sealed class ExportScheduleCommand : IBotCommand
{
    public string Name => "schedule";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var wanted = payload.Str("schedule");
        if (string.IsNullOrWhiteSpace(wanted)) return ExecResult.Fail("Nama schedule belum disebutkan.");

        var schedules = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSchedule))
            .Cast<ViewSchedule>()
            .Where(s => !s.IsTemplate)
            // Schedule "<Revision Schedule>" milik titleblock tidak bisa
            // di-export dan hanya menambah kebingungan saat mencari nama.
            .Where(s => !s.Name.StartsWith('<'))
            .ToList();

        var schedule = schedules.FirstOrDefault(s =>
                           string.Equals(s.Name, wanted, StringComparison.OrdinalIgnoreCase))
                       ?? schedules.FirstOrDefault(s =>
                           s.Name.Contains(wanted, StringComparison.OrdinalIgnoreCase));

        if (schedule is null)
        {
            var available = schedules
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .Take(20)
                .Select(s => "· " + s.Name);
            return ExecResult.Fail(
                $"Schedule \"{wanted}\" tidak ditemukan.\n\nYang ada:\n{string.Join("\n", available)}");
        }

        var folder = Path.Combine(Path.GetTempPath(), "RevitTelegramBridge");
        Directory.CreateDirectory(folder);

        var fileName = $"{SanitizeFileName(doc.Title)}_{SanitizeFileName(schedule.Name)}_" +
                       $"{DateTime.Now:yyyy-MM-dd}.csv";

        // Export read-only — tidak butuh Transaction.
        schedule.Export(folder, fileName, BuildOptions());

        var path = Path.Combine(folder, fileName);
        if (!File.Exists(path)) return ExecResult.Fail("Export selesai tapi berkas CSV tidak ditemukan.");

        var bytes = WithUtf8Bom(File.ReadAllBytes(path));
        try { File.Delete(path); } catch { /* biarkan; %TEMP% dibersihkan Windows */ }

        var rows = CountRows(bytes);
        return ExecResult.WithFile($"{schedule.Name} · {rows} baris", fileName, bytes);
    }

    private static ViewScheduleExportOptions BuildOptions() => new()
    {
        FieldDelimiter = ",",
        // Tanpa qualifier, satu nama panel yang mengandung koma menggeser
        // seluruh kolom di sisanya baris — rusak yang tidak terlihat rusak.
        TextQualifier = ExportTextQualifier.DoubleQuote,
        Title = true,
        ColumnHeaders = ExportColumnHeaders.OneRow,
        HeadersFootersBlanks = false,
    };

    /// <summary>
    /// Excel membaca CSV tanpa BOM sebagai ANSI, jadi nama berhuruf non-ASCII
    /// tampil rusak. Revit tidak menulis BOM, jadi ditambahkan di sini.
    /// </summary>
    private static byte[] WithUtf8Bom(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return bytes;

        var bom = Encoding.UTF8.GetPreamble();
        var result = new byte[bom.Length + bytes.Length];
        bom.CopyTo(result, 0);
        bytes.CopyTo(result, bom.Length);
        return result;
    }

    private static int CountRows(byte[] bytes) =>
        Encoding.UTF8.GetString(bytes).Split('\n').Count(l => !string.IsNullOrWhiteSpace(l));

    private static string SanitizeFileName(string input)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(input.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return cleaned.Replace(' ', '_');
    }
}
