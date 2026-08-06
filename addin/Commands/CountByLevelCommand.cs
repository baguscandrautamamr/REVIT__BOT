using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /count &lt;level&gt; [kategori] [--detail] — rekap elemen MEP per lantai.
/// </summary>
public sealed class CountByLevelCommand : IBotCommand
{
    public string Name => "count";

    /// <summary>
    /// Kategori yang dihitung.
    ///
    /// PERIKSA INI TERHADAP MODELMU. Banyak family fire alarm sebenarnya
    /// ter-load sebagai Electrical Fixtures, bukan Fire Alarm Devices — pilih
    /// satu smoke detector di Revit dan lihat kategorinya di Properties.
    /// Kalau meleset, baris itu melaporkan 0 tanpa terlihat salah.
    /// </summary>
    private static readonly (string Label, BuiltInCategory Category)[] Categories =
    {
        ("Lampu",       BuiltInCategory.OST_LightingFixtures),
        ("Stop kontak", BuiltInCategory.OST_ElectricalFixtures),
        ("Cable tray",  BuiltInCategory.OST_CableTray),
        ("Komunikasi",  BuiltInCategory.OST_CommunicationDevices),
        ("Fire alarm",  BuiltInCategory.OST_FireAlarmDevices),
        ("Telepon",     BuiltInCategory.OST_TelephoneDevices),
        ("Data / LAN",  BuiltInCategory.OST_DataDevices),
        ("Sekuriti",    BuiltInCategory.OST_SecurityDevices),
    };

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var input = payload.Str("level");
        if (string.IsNullOrWhiteSpace(input)) return ExecResult.Fail("Level belum disebutkan.");

        var level = LevelResolver.FindByName(doc, input);
        if (level is null)
            return ExecResult.Fail($"Level \"{input}\" tidak ditemukan. Ketik /levels untuk daftar nama persis.");

        var filter = payload.Str("category");
        var detail = payload.Flag("detail");

        var sb = new StringBuilder();
        sb.AppendLine(level.Name);
        sb.AppendLine();

        var total = 0;
        var anyRow = false;

        foreach (var (label, category) in Categories)
        {
            if (!string.IsNullOrWhiteSpace(filter) &&
                !label.Contains(filter, StringComparison.OrdinalIgnoreCase) &&
                !category.ToString().Contains(filter, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            // Elemen di dalam link TIDAK ikut terhitung oleh collector ini.
            // Itu perilaku Revit, bukan bug — sebutkan kalau angkanya dibandingkan
            // dengan schedule yang memasukkan link.
            var elements = new FilteredElementCollector(doc)
                .OfCategory(category)
                .WhereElementIsNotElementType()
                .Where(e => LevelResolver.Resolve(e) == level.Id)
                .ToList();

            if (elements.Count == 0 && !string.IsNullOrWhiteSpace(filter)) continue;

            anyRow = true;
            total += elements.Count;

            if (category == BuiltInCategory.OST_CableTray)
            {
                var metres = elements.Sum(LengthMetres);
                sb.AppendLine($"{label,-13} {elements.Count,5}   {metres,8:N1} m");
            }
            else
            {
                sb.AppendLine($"{label,-13} {elements.Count,5}");
            }

            if (detail && elements.Count > 0)
            {
                foreach (var group in elements
                             .GroupBy(TypeNameOf)
                             .OrderByDescending(g => g.Count()))
                {
                    sb.AppendLine($"   {group.Key,-24} {group.Count(),4}");
                }
            }
        }

        if (!anyRow) return ExecResult.Success($"{level.Name}\n\nTidak ada elemen MEP di lantai ini.");

        sb.AppendLine();
        sb.Append($"Total {total} elemen");

        return ExecResult.Success(sb.ToString());
    }

    private static double LengthMetres(Element e)
    {
        var p = e.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        // Panjang internal Revit dalam feet; 0.3048 m per feet.
        return p is null ? 0 : p.AsDouble() * 0.3048;
    }

    private static string TypeNameOf(Element e)
    {
        var typeId = e.GetTypeId();
        if (typeId == ElementId.InvalidElementId) return "(tanpa tipe)";
        return e.Document.GetElement(typeId)?.Name ?? "(tanpa tipe)";
    }
}
