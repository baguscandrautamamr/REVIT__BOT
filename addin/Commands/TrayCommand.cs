using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /tray &lt;level&gt; [--type] — panjang cable tray per lantai.
///
/// Default dikelompokkan per Comments, karena di proyek elektrikal itulah tempat
/// jenis tray biasanya ditulis ("LV LADDER", "ELV TRUNKING"). <c>--type</c>
/// mengelompokkan per nama TYPE Revit.
///
/// Dua-duanya disediakan karena keduanya benar untuk model yang berbeda, dan
/// tidak ada cara memilih dari luar: model yang Comments-nya rapi ingin
/// dikelompokkan per Comments, model yang Comments-nya kosong tidak punya apa pun
/// di sana. Sebelum ada flag ini, model kedua diam-diam jatuh ke nama type — hasil
/// yang benar, tapi lewat jalur yang tidak pernah disebutkan kepada pembacanya,
/// jadi tidak ada cara membedakannya dari pengelompokan per Comments yang
/// kebetulan mirip. Sekarang dasar pengelompokannya ikut dicetak.
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

        // `groupBy` sudah dikirim server sejak awal tapi belum pernah dibaca di
        // sini; sekarang ia yang menentukan. Nilai apa pun selain "type" berarti
        // Comments — jadi add-in versi ini tetap benar kalau dipasangkan dengan
        // server lama yang hanya pernah mengirim "comments".
        var byType = string.Equals(payload.Str("groupBy"), "type", StringComparison.OrdinalIgnoreCase);

        var groups = trays
            .GroupBy(e => GroupKeyOf(e, byType))
            .Select(g => (Key: g.Key, Count: g.Count(), Metres: g.Sum(LengthMetres)))
            .OrderByDescending(g => g.Metres)
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine(level.Name);

        // Dasar pengelompokan disebut, bukan diasumsikan terbaca dari isinya.
        // "LV LADDER" dan "Cable Tray 300mm" sama-sama masuk akal sebagai nama
        // type MAUPUN sebagai Comments, jadi tanpa baris ini tidak ada cara
        // memastikan angka di bawahnya dikelompokkan seperti yang dimaksud.
        sb.AppendLine(byType ? "(per nama type)" : "(per Comments — /tray --type untuk per nama type)");
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

    private static string GroupKeyOf(Element e, bool byType)
    {
        if (!byType)
        {
            var comments = e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString();
            if (!string.IsNullOrWhiteSpace(comments)) return comments;
        }

        // Nama tipe: tujuan langsung `--type`, sekaligus cadangan saat Comments
        // kosong. Cadangan itu tetap lebih berguna daripada satu baris
        // "(tanpa keterangan)" yang menampung segalanya — dan karena dasar
        // pengelompokan sekarang dicetak di balasannya, jatuh ke sini tidak lagi
        // menyamar sebagai pengelompokan per Comments.
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
