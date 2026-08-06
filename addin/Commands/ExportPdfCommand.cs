using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /pdf &lt;sheet…&gt; — export sheet ke PDF dengan skala presisi 1:1.
///
/// Memakai PDFExportOptions (Revit 2022+), BUKAN PrintManager: jalur print
/// driver memunculkan dialog dan menggantung proses tanpa ada yang bisa
/// menekan OK di PC yang tidak ditunggui.
/// </summary>
public sealed class ExportPdfCommand : IBotCommand
{
    public string Name => "pdf";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var wanted = payload.StrList("views");
        if (wanted.Count == 0) return ExecResult.Fail("Sheet belum disebutkan.");

        var sheets = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsTemplate)
            .ToList();

        var matched = new List<ViewSheet>();
        var missing = new List<string>();

        foreach (var name in wanted)
        {
            var sheet = sheets.FirstOrDefault(s =>
                            string.Equals(s.SheetNumber, name, StringComparison.OrdinalIgnoreCase))
                        ?? sheets.FirstOrDefault(s =>
                            s.SheetNumber.Contains(name, StringComparison.OrdinalIgnoreCase));

            if (sheet is null) missing.Add(name);
            else if (!matched.Contains(sheet)) matched.Add(sheet);
        }

        if (matched.Count == 0)
            return ExecResult.Fail($"Sheet tidak ditemukan: {string.Join(", ", missing)}");

        var folder = Path.Combine(Path.GetTempPath(), "RevitTelegramBridge");
        Directory.CreateDirectory(folder);

        var stamp = DateTime.Now.ToString("yyyy-MM-dd");
        var project = SanitizeFileName(doc.Title);
        var baseName = matched.Count == 1
            ? $"{project}_{SanitizeFileName(matched[0].SheetNumber)}_{stamp}"
            : $"{project}_{matched.Count}sheets_{stamp}";

        var options = BuildOptions(baseName);

        // doc.Export() tidak butuh Transaction — operasinya read-only.
        var ok = doc.Export(folder, matched.Select(s => s.Id).ToList(), options);
        if (!ok) return ExecResult.Fail("Revit menolak export PDF. Cek warning di model.");

        var file = new DirectoryInfo(folder)
            .GetFiles("*.pdf")
            .Where(f => f.Name.StartsWith(baseName, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .FirstOrDefault();

        if (file is null) return ExecResult.Fail("Export selesai tapi berkas PDF tidak ditemukan.");

        var bytes = File.ReadAllBytes(file.FullName);
        try { file.Delete(); } catch { /* biarkan; %TEMP% dibersihkan Windows */ }

        var text = $"{matched.Count} sheet: {string.Join(", ", matched.Select(s => s.SheetNumber))}";
        if (missing.Count > 0) text += $"\nDilewati (tidak ditemukan): {string.Join(", ", missing)}";

        return ExecResult.WithFile(text, file.Name, bytes);
    }

    /// <summary>
    /// Tiga setelan yang menentukan skala 1:1. Salah satu saja meleset,
    /// hasilnya bukan gambar kerja lagi:
    ///   MarginType.Default   → konten bergeser ~5 mm
    ///   ZoomType.FitToPage   → skala rusak total
    ///   PaperFormat salah    → A1 tercetak ke A4
    ///
    /// Nama enum ditulis mengikuti API Revit 2025. Kalau ada yang tidak
    /// compile, cocokkan dengan RevitAPI.chm — bukan dengan menebak.
    /// </summary>
    private static PDFExportOptions BuildOptions(string fileName) => new()
    {
        FileName = fileName,
        Combine = true,                          // satu PDF untuk beberapa sheet
        PaperFormat = ExportPaperFormat.Default, // Default = ikut ukuran titleblock
        ZoomType = ZoomType.Zoom,
        ZoomPercentage = 100,
        MarginType = MarginType.NoMargin,
        HideCropBoundaries = true,
        HideScopeBoxes = true,
        HideReferencePlane = true,
        HideUnreferencedViewTags = true,
        MaskCoincidentLines = true,
        ColorDepth = ColorDepthType.Color,
        RasterQuality = RasterQualityType.High,
    };

    private static string SanitizeFileName(string input)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(input.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return cleaned.Replace(' ', '_');
    }
}
