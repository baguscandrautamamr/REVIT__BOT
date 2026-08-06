using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /panel &lt;nama&gt; — isi panel schedule: daftar circuit beserta bebannya.
///
/// Dibaca dari MODEL, bukan dari view panel schedule. Alasannya: view panel
/// schedule hanya ada kalau seseorang sudah membuatnya, sementara circuit-nya
/// selalu ada begitu panelnya di-circuit. Membaca modelnya berarti /panel tetap
/// menjawab di proyek yang schedule-nya belum dibuat.
/// </summary>
public sealed class PanelCommand : IBotCommand
{
    public string Name => "panel";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var wanted = payload.Str("panel");
        if (string.IsNullOrWhiteSpace(wanted)) return ExecResult.Fail("Nama panel belum disebutkan.");

        var equipment = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_ElectricalEquipment)
            .WhereElementIsNotElementType()
            .Cast<FamilyInstance>()
            .ToList();

        var panel = equipment.FirstOrDefault(e => Eq(PanelName(e), wanted))
                    ?? equipment.FirstOrDefault(e => Has(PanelName(e), wanted));

        if (panel is null)
        {
            var names = equipment.Select(PanelName).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct()!;
            return ExecResult.Fail(
                $"Panel \"{wanted}\" tidak ditemukan.\n\nYang ada:\n{ViewFinder.Suggest(names!)}");
        }

        // Circuit yang DISUPLAI panel ini. `GetElectricalSystems()` akan
        // mengembalikan circuit yang MEMBERI daya ke panel — arah sebaliknya,
        // dan memakainya di sini akan melaporkan satu baris feeder alih-alih
        // seluruh isi panel.
        var circuits = panel.MEPModel?.GetAssignedElectricalSystems()?.ToList() ?? new List<ElectricalSystem>();

        var sb = new StringBuilder();
        sb.AppendLine(PanelName(panel) ?? panel.Name);
        var location = LevelName(doc, panel);
        if (location is not null) sb.AppendLine($"Lantai: {location}");
        sb.AppendLine();

        if (circuits.Count == 0)
        {
            sb.Append("Belum ada circuit yang di-assign ke panel ini.");
            return ExecResult.Success(sb.ToString());
        }

        // Angka dulu, nama beban PALING BELAKANG.
        //
        // Susunan lama menaruh nama beban di tengah dan memotongnya di huruf
        // ke-22, jadi "LIGHTING GROUND FLOOR ZONE A" dan "LIGHTING GROUND FLOOR
        // ZONE B" tercetak sama persis — dua circuit berbeda yang tidak bisa
        // dibedakan, di tabel yang gunanya justru membedakan circuit. Dengan
        // nama di belakang, ia bisa dibungkus ke baris berikutnya tanpa
        // menggeser satu pun kolom angka.
        sb.AppendLine($"{"CKT",-6}{"VA",7} {"P",3} {"A",4}  Beban");
        sb.AppendLine(Layout.Rule());

        double totalVa = 0;
        foreach (var circuit in circuits.OrderBy(c => Natural(CircuitNumber(c))))
        {
            var va = Apparent(circuit);
            totalVa += va;

            var lead = $"{CircuitNumber(circuit),-6}{va,7:N0} {Poles(circuit),3} {Rating(circuit),4:N0}  ";
            Layout.Hanging(sb, lead, circuit.LoadName, lead.Length);
        }

        sb.AppendLine(Layout.Rule());
        sb.AppendLine($"{circuits.Count} circuit · total {totalVa:N0} VA ({totalVa / 1000:N1} kVA)");

        return ExecResult.Success(sb.ToString().TrimEnd());
    }

    private static string? PanelName(Element e) =>
        e.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString();

    private static string CircuitNumber(ElectricalSystem c)
    {
        try { return c.CircuitNumber ?? "—"; }
        catch { return "—"; }
    }

    /// <summary>
    /// Apparent load satu circuit, dalam VA.
    ///
    /// `ElectricalSystem.ApparentLoad` mengembalikan SATUAN INTERNAL Revit, bukan
    /// VA. Versi sebelumnya memakainya apa adanya, dan angkanya meleset 10,7639
    /// kali — persis faktor ft² per m², sebab satuan daya internal Revit
    /// diturunkan dari kaki, bukan meter.
    ///
    /// Meleset sepuluh kali lipat tidak terbaca sebagai kesalahan satuan; ia
    /// terbaca sebagai panel yang kelebihan beban. Dicocokkan dengan panel
    /// schedule aslinya:
    ///
    ///   circuit (D)/107  →  bot 6.458    schedule    600 VA   (600 × 10,7639)
    ///   total            →  bot 1.421.719    schedule 132.082 VA
    ///
    /// `Rating` sengaja TIDAK ikut dikonversi: satuan internal Revit untuk arus
    /// memang ampere, dan angkanya sudah cocok dengan MCB di schedule (20 A).
    /// </summary>
    private static double Apparent(ElectricalSystem c)
    {
        try { return UnitUtils.ConvertFromInternalUnits(c.ApparentLoad, UnitTypeId.VoltAmperes); }
        catch { return 0; }
    }

    private static int Poles(ElectricalSystem c)
    {
        try { return c.PolesNumber; }
        catch { return 0; }
    }

    private static double Rating(ElectricalSystem c)
    {
        try { return c.Rating; }
        catch { return 0; }
    }

    private static string? LevelName(Document doc, Element e)
    {
        var id = LevelResolver.Resolve(e);
        return id == ElementId.InvalidElementId ? null : doc.GetElement(id)?.Name;
    }

    /// <summary>"10" harus datang sesudah "9", bukan sesudah "1".</summary>
    private static string Natural(string s)
    {
        var digits = new string(s.Where(char.IsDigit).ToArray());
        return digits.Length > 0 ? digits.PadLeft(6, '0') : s;
    }

    private static bool Eq(string? a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private static bool Has(string? a, string b) => a is not null && a.Contains(b, StringComparison.OrdinalIgnoreCase);
}
