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

        sb.AppendLine($"{"Circuit",-10} {"Beban",-22} {"VA",8} {"P",3} {"A",5}");
        sb.AppendLine(new string('-', 52));

        double totalVa = 0;
        foreach (var circuit in circuits.OrderBy(c => Natural(CircuitNumber(c))))
        {
            var va = Apparent(circuit);
            totalVa += va;
            sb.AppendLine(
                $"{Trim(CircuitNumber(c: circuit), 10),-10} " +
                $"{Trim(circuit.LoadName, 22),-22} " +
                $"{va,8:N0} " +
                $"{Poles(circuit),3} " +
                $"{Rating(circuit),5:N0}");
        }

        sb.AppendLine(new string('-', 52));
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

    private static double Apparent(ElectricalSystem c)
    {
        try { return c.ApparentLoad; }
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

    private static string Trim(string? s, int max)
    {
        s ??= "—";
        return s.Length <= max ? s : s[..(max - 1)] + "…";
    }

    private static bool Eq(string? a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private static bool Has(string? a, string b) => a is not null && a.Contains(b, StringComparison.OrdinalIgnoreCase);
}
