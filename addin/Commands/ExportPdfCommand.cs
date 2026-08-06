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

        var picked = ViewFinder.ResolveSheets(doc, wanted);
        var matched = picked.Matched;

        if (matched.Count == 0)
        {
            var names = ViewFinder.Sheets(doc).Select(s => $"{s.SheetNumber} — {s.Name}");
            return ExecResult.Fail(
                $"Sheet tidak ditemukan.{picked.Notes()}\n\nYang ada:\n{ViewFinder.Suggest(names)}");
        }

        // Folder BARU untuk tiap export. Dulu semua export berbagi satu folder
        // %TEMP%\RevitTelegramBridge dan hasilnya dicari dengan mencocokkan
        // awalan nama: sisa export sebelumnya yang gagal dihapus bisa terpungut
        // dan terkirim sebagai "hasil" — PDF sheet yang salah, tanpa satu pun
        // tanda bahwa itu bukan yang diminta.
        using var workspace = new ExportWorkspace("pdf");

        var baseName = matched.Count == 1
            ? $"{ExportWorkspace.Sanitize(doc.Title)}_{ExportWorkspace.Sanitize(matched[0].SheetNumber)}_{ExportWorkspace.Stamp()}"
            : $"{ExportWorkspace.Sanitize(doc.Title)}_{matched.Count}sheets_{ExportWorkspace.Stamp()}";

        var options = BuildOptions(baseName);

        // doc.Export() tidak butuh Transaction — operasinya read-only.
        var ok = doc.Export(workspace.Folder, matched.Select(s => s.Id).ToList(), options);
        if (!ok) return ExecResult.Fail("Revit menolak export PDF. Cek warning di model.");

        var file = workspace.Collect("pdf", $"{baseName}.zip");
        if (file is null) return ExecResult.Fail("Export selesai tapi berkas PDF tidak ditemukan.");

        var text = $"{matched.Count} sheet: {string.Join(", ", matched.Select(s => s.SheetNumber))}"
                 + picked.Notes();

        return ExecResult.WithFile(text, file.Value.Name, file.Value.Bytes);
    }

    /// <summary>
    /// Tiga setelan yang menentukan skala 1:1. Salah satu saja meleset,
    /// hasilnya bukan gambar kerja lagi:
    ///   PaperPlacementType.Margins → konten bergeser sebesar margin printer
    ///   ZoomType.FitToPage         → skala rusak total
    ///   PaperFormat salah          → A1 tercetak ke A4
    ///
    /// Catatan yang mahal: `MarginType.NoMargin` TERLIHAT seperti jawabannya dan
    /// enum itu memang ada di Autodesk.Revit.DB — tapi ia milik PrintParameters
    /// (API print lama), bukan PDFExportOptions. Padanannya di sini
    /// `PaperPlacement`, dan Center berarti tanpa offset margin sama sekali.
    /// </summary>
    private static PDFExportOptions BuildOptions(string fileName) => new()
    {
        FileName = fileName,
        Combine = true,                          // satu PDF untuk beberapa sheet
        PaperFormat = ExportPaperFormat.Default, // Default = ikut ukuran titleblock
        ZoomType = ZoomType.Zoom,
        ZoomPercentage = 100,
        PaperPlacement = PaperPlacementType.Center,
        HideCropBoundaries = true,
        HideScopeBoxes = true,
        HideReferencePlane = true,
        HideUnreferencedViewTags = true,
        MaskCoincidentLines = true,
        ColorDepth = ColorDepthType.Color,
        RasterQuality = RasterQualityType.High,
    };

}
