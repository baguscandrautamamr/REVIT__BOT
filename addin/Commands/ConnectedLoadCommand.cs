using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /load &lt;level&gt; — total connected load per lantai.
///
/// DEFINISI yang dipakai, dan ia disebutkan juga di balasannya: jumlah apparent
/// load (VA) dari elemen yang BERADA di lantai itu — bukan yang disuplai dari
/// panel di lantai itu. Keduanya angka yang sah dan berbeda jauh, dan angka
/// beban yang definisinya tidak disebutkan lebih berbahaya daripada tidak ada
/// angka sama sekali: ia terlihat seperti fakta.
/// </summary>
public sealed class ConnectedLoadCommand : IBotCommand
{
    private static readonly (string Label, BuiltInCategory Category)[] Categories =
    {
        ("Lampu",        BuiltInCategory.OST_LightingFixtures),
        ("Stop kontak",  BuiltInCategory.OST_ElectricalFixtures),
        ("Panel/equip",  BuiltInCategory.OST_ElectricalEquipment),
        ("Komunikasi",   BuiltInCategory.OST_CommunicationDevices),
        ("Fire alarm",   BuiltInCategory.OST_FireAlarmDevices),
        ("Data / LAN",   BuiltInCategory.OST_DataDevices),
        ("Sekuriti",     BuiltInCategory.OST_SecurityDevices),
    };

    public string Name => "load";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var wanted = payload.Str("level");
        if (string.IsNullOrWhiteSpace(wanted)) return ExecResult.Fail("Level belum disebutkan.");

        var (level, others) = LevelResolver.Match(doc, wanted);
        if (level is null)
            return ExecResult.Fail($"Level \"{wanted}\" tidak ditemukan. Ketik /levels untuk daftar nama persis.");

        var sb = new StringBuilder();
        sb.AppendLine(level.Name);
        if (others.Count > 0)
            sb.AppendLine($"(cocok juga: {string.Join(", ", others.Select(l => l.Name))})");
        sb.AppendLine();

        double totalVa = 0;
        var counted = 0;
        var withoutLoad = 0;
        var rows = new List<(string Label, string Tail)>();

        foreach (var (label, category) in Categories)
        {
            double va = 0;
            var n = 0;

            foreach (var e in new FilteredElementCollector(doc)
                         .OfCategory(category)
                         .WhereElementIsNotElementType())
            {
                if (LevelResolver.Resolve(e) != level.Id) continue;
                n++;

                var load = ApparentVa(e);
                if (load is null) { withoutLoad++; continue; }
                va += load.Value;
                counted++;
            }

            if (n == 0) continue;
            totalVa += va;
            rows.Add((Label: label, Tail: $"{n,5} bh {va,10:N0} VA"));
        }

        if (rows.Count == 0)
        {
            sb.Append("Tidak ada elemen elektrikal di lantai ini.");
            return ExecResult.Success(sb.ToString());
        }

        // Kolom label dipatok, tapi yang melewatinya turun ke barisnya sendiri
        // alih-alih menggeser kolom angkanya — deretan VA harus tetap lurus
        // supaya bisa dibandingkan sekali lihat.
        var width = Math.Min(rows.Max(r => r.Label.Length), 20) + 1;
        foreach (var row in rows) Layout.Row(sb, row.Label, row.Tail, width);
        sb.AppendLine();
        sb.AppendLine($"Total {totalVa:N0} VA  ({totalVa / 1000:N1} kVA)");
        sb.AppendLine($"Dari {counted} elemen yang punya nilai beban.");

        // Angka nol yang tidak dijelaskan akan dikira beban yang memang nol.
        // Yang jauh lebih sering terjadi: family-nya tidak punya parameter
        // beban terisi sama sekali.
        if (withoutLoad > 0)
            sb.AppendLine($"{withoutLoad} elemen dilewati — parameternya kosong, bukan nol.");

        sb.Append("\nHitungan ini memakai LOKASI elemen, bukan panel yang menyuplainya.");

        return ExecResult.Success(sb.ToString().TrimEnd());
    }

    /// <summary>
    /// Apparent load satu elemen, dalam VA.
    ///
    /// Mengembalikan null — BUKAN nol — kalau parameternya tidak ada atau tidak
    /// diisi. Bedanya penting: nol berarti "diukur, hasilnya nol", null berarti
    /// "tidak diukur", dan menjumlahkan keduanya sebagai nol menyembunyikan
    /// separuh model di balik angka yang terlihat meyakinkan.
    /// </summary>
    private static double? ApparentVa(Element e)
    {
        var p = e.get_Parameter(BuiltInParameter.RBS_ELEC_APPARENT_LOAD);
        if (p is null || !p.HasValue) return null;

        // Satuan internal Revit untuk daya adalah watt; VA dan W sama besarnya
        // secara numerik di sini karena Revit menyimpan apparent load apa adanya.
        var raw = p.AsDouble();
        return UnitUtils.ConvertFromInternalUnits(raw, UnitTypeId.VoltAmperes);
    }
}
