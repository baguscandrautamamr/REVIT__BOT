using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /dwg &lt;sheet…&gt; — export sheet ke DWG.
///
/// Untuk dikirim ke pihak lain yang tidak punya Revit. Beberapa sheet sekaligus
/// dibungkus zip: Revit menulis satu DWG per sheet, dan tiga berkas terpisah
/// yang datang tanpa urutan lebih merepotkan daripada satu zip.
/// </summary>
public sealed class ExportDwgCommand : IBotCommand
{
    public string Name => "dwg";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var group = GroupExport.Run(doc, payload, "dwg", ExportGroup);
        if (group is not null) return group;

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

        using var workspace = new ExportWorkspace("dwg");

        var baseName = matched.Count == 1
            ? $"{ExportWorkspace.Sanitize(doc.Title)}_{ExportWorkspace.Sanitize(matched[0].SheetNumber)}_{ExportWorkspace.Stamp()}"
            : $"{ExportWorkspace.Sanitize(doc.Title)}_{matched.Count}sheets_{ExportWorkspace.Stamp()}";

        var ok = doc.Export(workspace.Folder, baseName, matched.Select(s => s.Id).ToList(), Options());
        if (!ok) return ExecResult.Fail("Revit menolak export DWG. Cek warning di model.");

        var file = workspace.Collect("dwg", $"{baseName}.zip");
        if (file is null) return ExecResult.Fail("Export selesai tapi berkas DWG tidak ditemukan.");

        var text = $"{matched.Count} sheet: {string.Join(", ", matched.Select(s => s.SheetNumber))}"
                 + picked.Notes();

        return ExecResult.WithFile(text, file.Value.Name, file.Value.Bytes);
    }

    private static DWGExportOptions Options() => new()
    {
        // Satu DWG per sheet, dengan seluruh view di dalamnya digabung.
        // Tanpa ini setiap viewport keluar sebagai berkas XREF terpisah,
        // dan penerimanya mendapat sekantong berkas yang saling menunjuk.
        MergedViews = true,
        SharedCoords = true,
        ExportOfSolids = SolidGeometry.Polymesh,
        TargetUnit = ExportUnit.Millimeter,
        FileVersion = ACADVersion.R2018,
    };

    /// <summary>
    /// Satu grup → satu set DWG, dinamai menurut grupnya.
    ///
    /// Berbeda dari PDF, Revit menulis SATU DWG PER SHEET di sini — `MergedViews`
    /// hanya menggabungkan viewport di dalam satu sheet, bukan sheet-nya satu sama
    /// lain. Nama grup tetap masuk ke nama tiap berkas, karena Revit menempelkan
    /// nomor sheet-nya sendiri di belakang nama yang kita minta.
    /// </summary>
    private static void ExportGroup(Document doc, ExportWorkspace workspace, SheetGroup group, string prefix)
    {
        var name = $"{prefix}_{ExportWorkspace.Sanitize(group.Key)}_{ExportWorkspace.Stamp()}";
        var ok = doc.Export(workspace.Folder, name, group.Sheets.Select(s => s.Id).ToList(), Options());
        if (!ok) throw new InvalidOperationException($"Revit menolak export DWG untuk grup \"{group.Key}\".");
    }
