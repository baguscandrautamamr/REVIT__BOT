using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

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

    private static string LatestRevision(Document doc, ViewSheet sheet)
    {
        var ids = sheet.GetAllRevisionIds();
        if (ids.Count == 0) return "—";

        // GetAllRevisionIds mengembalikan urutan sesuai urutan revisi di model;
        // yang terakhir adalah yang terbaru.
        var last = doc.GetElement(ids[^1]) as Revision;
        return last?.RevisionNumber ?? "—";
    }
}
