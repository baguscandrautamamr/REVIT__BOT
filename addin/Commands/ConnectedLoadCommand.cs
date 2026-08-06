using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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
                var (value, source) = ApparentVa(e);
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
                          $"\"{ElectricalDataParam}\" maupun \"Apparent Load\".");
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

    /* ── Dari mana angka bebannya dibaca ──────────────────────────────────── */

    /// <summary>Parameter ringkasan connector di Revit: "220 V/1-31 VA".</summary>
    internal const string ElectricalDataParam = "Electrical Data";

    /// <summary>Angka tepat sebelum satuan VA, berapa pun connector-nya.</summary>
    private static readonly Regex VaPattern = new(@"([\d.,]+)\s*VA\b", RegexOptions.IgnoreCase);

    /// <summary>
    /// Apparent load satu elemen dalam VA, beserta dari mana angkanya diambil.
    ///
    /// `Electrical Data` DIDAHULUKAN, dan itu berdasarkan model yang sebenarnya:
    /// `RBS_ELEC_APPARENT_LOAD` di instance kosong untuk seluruh 605 elemen di
    /// proyek ini — beban lampu dan stop kontaknya didefinisikan di connector
    /// keluarga, dan yang menampilkannya adalah string ringkasan itu. Membaca
    /// parameter yang kosong lalu melaporkan "Total 0 VA" bukan cuma tidak
    /// menolong; ia angka yang terlihat seperti hasil pengukuran.
    ///
    /// Mengembalikan null — BUKAN nol — kalau tidak ada satu pun sumber yang
    /// terisi. Bedanya penting: nol berarti "diukur, hasilnya nol", null berarti
    /// "tidak diukur", dan menjumlahkan keduanya sebagai nol menyembunyikan
    /// separuh model di balik angka yang meyakinkan.
    /// </summary>
    private static (double? Va, string Source) ApparentVa(Element e)
    {
        var doc = e.Document;
        var type = doc.GetElement(e.GetTypeId());

        var text = FromElectricalData(e) ?? FromElectricalData(type);
        if (text is not null) return (text, ElectricalDataParam);

        var param = FromApparentParam(e) ?? FromApparentParam(type);
        if (param is not null) return (param, "Apparent Load");

        return (null, "");
    }

    /// <summary>Jumlahkan SEMUA "… VA" di string — satu family bisa punya beberapa connector.</summary>
    private static double? FromElectricalData(Element? e)
    {
        var p = e?.LookupParameter(ElectricalDataParam);
        if (p is null) return null;

        var text = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString();
        if (string.IsNullOrWhiteSpace(text)) return null;

        double total = 0;
        var found = false;
        foreach (Match m in VaPattern.Matches(text))
        {
            if (TryNumber(m.Groups[1].Value, out var va)) { total += va; found = true; }
        }
        return found ? total : null;
    }

    private static double? FromApparentParam(Element? e)
    {
        var p = e?.get_Parameter(BuiltInParameter.RBS_ELEC_APPARENT_LOAD);
        if (p is null || !p.HasValue || p.StorageType != StorageType.Double) return null;

        // Satuan internal Revit untuk daya BUKAN VA — ia diturunkan dari kaki,
        // jadi angkanya meleset 10,7639 kali kalau dipakai apa adanya. Kesalahan
        // yang sama pernah membuat /panel melaporkan 1.421.719 VA untuk panel
        // yang schedule-nya menulis 132.082 VA.
        var va = UnitUtils.ConvertFromInternalUnits(p.AsDouble(), UnitTypeId.VoltAmperes);
        return va > 0 ? va : null;
    }

    /// <summary>
    /// "1.200" atau "1,200" → 1200; "31" → 31; "1,5" atau "1.5" → 1,5.
    ///
    /// Revit menulis angkanya memakai pemisah ribuan sesuai bahasa Windows-nya,
    /// dan di Indonesia titik berarti ribuan — kebalikan dari Inggris. Menebak
    /// salah pada "1.200" menghasilkan 1,2 VA untuk beban 1.200 VA: seperseribu,
    /// dan tetap terlihat seperti angka yang wajar.
    /// </summary>
    private static bool TryNumber(string raw, out double value)
    {
        var s = raw.Trim();

        // Pola ribuan: 1-3 digit, lalu kelompok tepat 3 digit berulang.
        if (Regex.IsMatch(s, @"^\d{1,3}([.,]\d{3})+$"))
        {
            return double.TryParse(s.Replace(".", "").Replace(",", ""),
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out value);
        }

        // Satu pemisah dengan digit selain kelipatan tiga = desimal.
        s = s.Replace(',', '.');
        return double.TryParse(s, System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out value);
    }
}
