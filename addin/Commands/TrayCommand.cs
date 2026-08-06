using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /tray &lt;level&gt; — panjang cable tray per lantai, dikelompokkan per Comments.
///
/// Comments dipakai sebagai pengelompokan karena di proyek elektrikal itulah
/// tempat jenis tray biasanya ditulis ("LV LADDER", "ELV TRUNKING"). Kalau di
/// modelmu jenis tray ada di parameter lain, ganti <see cref="GroupKeyOf"/> —
/// itu satu-satunya tempat yang perlu diubah.
/// </summary>
public sealed class TrayCommand : IBotCommand
{
    public string Name => "tray";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var input = payload.Str("level");
        if (string.IsNullOrWhiteSpace(input)) return ExecResult.Fail("Level belum disebutkan.");

        var level = LevelResolver.FindByName(doc, input);
        if (level is null)
            return ExecResult.Fail($"Level \"{input}\" tidak ditemukan. Ketik /levels untuk daftar nama persis.");

        // Cable tray dan fitting-nya dihitung terpisah: fitting tidak punya
        // panjang, jadi menjumlahkannya bersama tray akan terlihat seperti
        // total yang kurang tanpa ada yang menandainya.
        var trays = Collect(doc, BuiltInCategory.OST_CableTray, level.Id);
        var fittings = Collect(doc, BuiltInCategory.OST_CableTrayFitting, level.Id);

        if (trays.Count == 0 && fittings.Count == 0)
            return ExecResult.Success($"{level.Name}\n\nTidak ada cable tray di lantai ini.");

        var groups = trays
            .GroupBy(GroupKeyOf)
            .Select(g => (Key: g.Key, Count: g.Count(), Metres: g.Sum(LengthMetres)))
            .OrderByDescending(g => g.Metres)
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine(level.Name);
        sb.AppendLine();

        // Kolom selebar nama terpanjang yang masih wajar. Nama yang melewatinya
        // TIDAK dipotong — ia mengambil barisnya sendiri dan angkanya menyusul
        // di kolom yang sama, jadi deretan angkanya tetap lurus tanpa ada satu
        // pun nama tipe tray yang hilang separuh.
        // Lantai yang hanya berisi fitting tanpa satu pun segmen tray membuat
        // `groups` kosong — dan `Max()` atas urutan kosong melempar, bukan
        // mengembalikan nol.
        var width = groups.Count > 0 ? Math.Min(groups.Max(g => g.Key.Length), 24) + 1 : 1;

        foreach (var group in groups)
            Layout.Row(sb, group.Key, $"{group.Count,5} bh {group.Metres,9:N1} m", width);

        sb.AppendLine();
        sb.AppendLine($"Total {trays.Count} segmen · {trays.Sum(LengthMetres):N1} m");
        if (fittings.Count > 0) sb.Append($"Fitting: {fittings.Count} buah (tanpa panjang)");

        return ExecResult.Success(sb.ToString().TrimEnd());
    }

    private static List<Element> Collect(Document doc, BuiltInCategory category, ElementId levelId) =>
        new FilteredElementCollector(doc)
            .OfCategory(category)
            .WhereElementIsNotElementType()
            .Where(e => LevelResolver.Resolve(e) == levelId)
            .ToList();

    private static string GroupKeyOf(Element e)
    {
        var comments = e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString();
        if (!string.IsNullOrWhiteSpace(comments)) return comments;

        // Tanpa Comments, nama tipe masih lebih berguna daripada satu baris
        // "(tanpa keterangan)" yang menampung segalanya.
        var typeId = e.GetTypeId();
        if (typeId != ElementId.InvalidElementId)
        {
            var name = e.Document.GetElement(typeId)?.Name;
            if (!string.IsNullOrWhiteSpace(name)) return name;
        }

        return "(tanpa keterangan)";
    }

    private static double LengthMetres(Element e)
    {
        var p = e.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        // Panjang internal Revit dalam feet; 0.3048 m per feet.
        return p is null ? 0 : p.AsDouble() * 0.3048;
    }
}
