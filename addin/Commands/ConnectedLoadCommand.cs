using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /load &lt;level&gt; — total connected load per lantai.
///
/// DEFINISI yang dipakai, dan ia disebutkan juga di balasannya: jumlah apparent
/// load (VA) dari LAMPU dan STOP KONTAK yang berada di lantai itu — bukan yang
/// disuplai dari panel di lantai itu. Keduanya angka yang sah dan berbeda jauh,
/// dan angka beban yang definisinya tidak disebutkan lebih berbahaya daripada
/// tidak ada angka sama sekali: ia terlihat seperti fakta.
///
/// Hanya dua kategori itu yang masuk hitungan. Panel, fire alarm, komunikasi,
/// dan sekuriti tetap DIHITUNG JUMLAHNYA tapi tidak menambah VA: panel adalah
/// yang menyuplai, bukan yang dibebankan — menjumlahkannya berarti menghitung
/// beban yang sama dua kali.
/// </summary>
public sealed class ConnectedLoadCommand : IBotCommand
{
    /// <summary>Yang bebannya dijumlahkan.</summary>
    private static readonly (string Label, BuiltInCategory Category)[] Powered =
    {
        ("Lampu",       BuiltInCategory.OST_LightingFixtures),
        ("Stop kontak", BuiltInCategory.OST_ElectricalFixtures),
    };

    /// <summary>Dihitung jumlahnya saja — supaya tidak terlihat hilang.</summary>
    private static readonly (string Label, BuiltInCategory Category)[] Counted =
    {
        ("Panel/equip", BuiltInCategory.OST_ElectricalEquipment),
        ("Komunikasi",  BuiltInCategory.OST_CommunicationDevices),
        ("Fire alarm",  BuiltInCategory.OST_FireAlarmDevices),
        ("Data / LAN",  BuiltInCategory.OST_DataDevices),
        ("Sekuriti",    BuiltInCategory.OST_SecurityDevices),
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
        var sources = new HashSet<string>();
        var rows = new List<(string Label, string Tail)>();

        foreach (var (label, category) in Powered)
        {
            double va = 0;
            var n = 0;

            foreach (var e in Collect(doc, category, level))
            {
                n++;
                var (value, source) = ElectricalLoad.ApparentVa(e);
                if (value is null) { withoutLoad++; continue; }
                va += value.Value;
                counted++;
                sources.Add(source);
            }

            if (n == 0) continue;
            totalVa += va;
            rows.Add((Label: label, Tail: $"{n,5} bh {va,10:N0} VA"));
        }

        if (rows.Count == 0)
        {
            sb.Append("Tidak ada lampu atau stop kontak di lantai ini.");
            return ExecResult.Success(sb.ToString());
        }

        var width = Math.Min(rows.Max(r => r.Label.Length), 20) + 1;
        foreach (var row in rows) Layout.Row(sb, row.Label, row.Tail, width);

        sb.AppendLine(Layout.Rule());
        sb.AppendLine($"Total {totalVa:N0} VA  ({totalVa / 1000:N1} kVA)");
        sb.AppendLine($"Dari {counted} elemen yang punya nilai beban.");

        // DARI MANA angkanya dibaca ikut disebut. Satu model bisa mengisi
        // bebannya di tempat yang berbeda dari model lain, dan tanpa baris ini
        // "totalnya 0" tidak bisa dibedakan dari "bebannya memang nol".
        if (sources.Count > 0) sb.AppendLine($"Sumber angka: {string.Join(" + ", sources.OrderBy(s => s))}");

        // Angka nol yang tidak dijelaskan akan dikira beban yang memang nol.
        // Yang jauh lebih sering terjadi: family-nya tidak punya parameter beban
        // terisi sama sekali.
        if (withoutLoad > 0)
        {
            sb.AppendLine($"{withoutLoad} elemen dilewati — tidak ada nilai di " +
                          $"\"{ElectricalLoad.ElectricalDataParam}\" maupun \"Apparent Load\".");
        }

        // Kategori lain: jumlahnya disebut, VA-nya tidak. Menghilangkannya sama
        // sekali membuat orang mengira elemennya tidak ada di lantai itu.
        var extras = new List<(string Label, string Tail)>();
        foreach (var (label, category) in Counted)
        {
            var n = Collect(doc, category, level).Count();
            if (n > 0) extras.Add((label, $"{n,5} bh"));
        }

        if (extras.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("Tidak dihitung sebagai beban:");
            var w = Math.Min(extras.Max(r => r.Label.Length), 20) + 1;
            foreach (var row in extras) Layout.Row(sb, "  " + row.Label, row.Tail, w + 2);
        }

        sb.Append("\nHitungan ini memakai LOKASI elemen, bukan panel yang menyuplainya.");

        return ExecResult.Success(sb.ToString().TrimEnd());
    }

    private static IEnumerable<Element> Collect(Document doc, BuiltInCategory category, Level level) =>
        new FilteredElementCollector(doc)
            .OfCategory(category)
            .WhereElementIsNotElementType()
            .Where(e => LevelResolver.Resolve(e) == level.Id);
}
