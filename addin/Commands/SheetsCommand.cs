using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitTelegramBridge.Services;

namespace RevitTelegramBridge.Commands;

/// <summary>/sheets [filter] — daftar sheet beserta revisi terakhir.</summary>
public sealed class SheetsCommand : IBotCommand
{
    public string Name => "sheets";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var filter = payload.Str("filter");

        var sheets = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsTemplate)
            .Where(s => string.IsNullOrWhiteSpace(filter)
                        || s.SheetNumber.Contains(filter, StringComparison.OrdinalIgnoreCase)
                        || s.Name.Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (sheets.Count == 0)
            return ExecResult.Success(string.IsNullOrWhiteSpace(filter)
                ? "Tidak ada sheet di model ini."
                : $"Tidak ada sheet yang cocok dengan \"{filter}\".");

        var sb = new StringBuilder();
        var numWidth = sheets.Max(s => s.SheetNumber.Length);

        foreach (var sheet in sheets)
        {
            var revision = LatestRevision(doc, sheet);
            var name = sheet.Name.Length > 30 ? sheet.Name[..29] + "…" : sheet.Name;
            sb.AppendLine($"{sheet.SheetNumber.PadRight(numWidth)}  {name,-30} {revision}");
        }

        sb.AppendLine();
        sb.Append($"{sheets.Count} sheet");

        return ExecResult.Success(sb.ToString());
    }

    /// <summary>
    /// Nomor revisi terakhir pada satu sheet.
    ///
    /// Nomornya dibaca lewat SHEET-nya, bukan lewat objek Revision. Kalau
    /// "revision numbering" model di-set per sheet, `Revision.RevisionNumber`
    /// melempar InvalidOperationException:
    ///
    ///   This operation is not valid for when the revision numbering is per sheet.
    ///
    /// Karena dipanggil di dalam loop, satu model seperti itu membuat SELURUH
    /// /sheets gagal — bukan cuma kolom revisinya yang kosong. Itu benar-benar
    /// terjadi di lapangan. `GetRevisionNumberOnSheet` sah untuk kedua mode
    /// penomoran dan mengembalikan angka yang persis tercetak di sheet.
    /// </summary>
    private static string LatestRevision(Document doc, ViewSheet sheet)
    {
        var ids = sheet.GetAllRevisionIds();
        if (ids.Count == 0) return "—";

        // GetAllRevisionIds mengembalikan urutan sesuai urutan revisi di model;
        // yang terakhir adalah yang terbaru.
        var id = ids[^1];

        try
        {
            var onSheet = sheet.GetRevisionNumberOnSheet(id);
            if (!string.IsNullOrWhiteSpace(onSheet)) return onSheet;
        }
        catch (Exception ex)
        {
            Log.Warn($"nomor revisi sheet {sheet.SheetNumber}: {ex.GetType().Name}: {ex.Message}");
        }

        // Cadangan: revisi yang tidak tampil di sheet (mis. sudah di-issue dan
        // disembunyikan) tetap punya nomor di tingkat project. SequenceNumber
        // selalu sah, apa pun mode penomorannya — jadi ia jadi jaring terakhir
        // supaya satu sheet aneh tidak menjatuhkan seluruh daftar.
        if (doc.GetElement(id) is not Revision revision) return "—";
        try
        {
            return revision.RevisionNumber;
        }
        catch (InvalidOperationException)
        {
            return $"#{revision.SequenceNumber}";
        }
    }
}
