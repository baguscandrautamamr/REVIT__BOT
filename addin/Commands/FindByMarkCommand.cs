using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /find &lt;mark&gt; — cari elemen dari nilai parameter Mark.
///
/// Gunanya di lapangan: seseorang membaca "LP-03" dari label di panel dan ingin
/// tahu itu ada di lantai berapa, tanpa harus menelepon orang yang di depan
/// Revit.
/// </summary>
public sealed class FindByMarkCommand : IBotCommand
{
    /// <summary>Batas hasil — Mark tidak dijamin unik, dan sering memang tidak.</summary>
    private const int MaxHits = 20;

    public string Name => "find";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var wanted = payload.Str("mark");
        if (string.IsNullOrWhiteSpace(wanted)) return ExecResult.Fail("Mark belum disebutkan.");

        // Menyaring lewat ParameterFilter akan lebih cepat, tapi Mark tersimpan
        // di BuiltInParameter yang berbeda tergantung jenis elemennya. Menyapu
        // sekali lalu membaca parameter jauh lebih sulit meleset — dan model
        // elektrikal satu gedung masih terhitung kecil untuk ini.
        var hits = new List<(Element Element, string Mark)>();

        foreach (var element in new FilteredElementCollector(doc).WhereElementIsNotElementType())
        {
            var mark = MarkOf(element);
            if (string.IsNullOrWhiteSpace(mark)) continue;

            if (string.Equals(mark, wanted, StringComparison.OrdinalIgnoreCase) ||
                mark.Contains(wanted, StringComparison.OrdinalIgnoreCase))
            {
                hits.Add((element, mark));
            }
        }

        if (hits.Count == 0)
            return ExecResult.Fail($"Tidak ada elemen dengan Mark yang cocok dengan \"{wanted}\".");

        // Yang persis sama didahulukan: pencarian longgar berguna, tapi hasil
        // yang tepat tidak boleh tenggelam di bawah yang kebetulan mengandung.
        var ordered = hits
            .OrderByDescending(h => string.Equals(h.Mark, wanted, StringComparison.OrdinalIgnoreCase))
            .ThenBy(h => h.Mark, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine($"{hits.Count} elemen cocok dengan \"{wanted}\"");
        sb.AppendLine();

        foreach (var (element, mark) in ordered.Take(MaxHits))
        {
            sb.AppendLine($"{mark}  ·  {CategoryOf(element)}");
            sb.AppendLine($"   Level : {LevelNameOf(doc, element)}");
            sb.AppendLine($"   Posisi: {PositionOf(element)}");
            sb.AppendLine($"   Id    : {element.Id}");
        }

        if (ordered.Count > MaxHits)
            sb.AppendLine($"…{ordered.Count - MaxHits} hasil lain tidak ditampilkan.");

        return ExecResult.Success(sb.ToString().TrimEnd());
    }

    private static string? MarkOf(Element e)
    {
        var mark = e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString();
        if (!string.IsNullOrWhiteSpace(mark)) return mark;

        // Panel dan sebagian peralatan elektrikal memakai Panel Name, bukan Mark.
        return e.get_Parameter(BuiltInParameter.RBS_ELEC_PANEL_NAME)?.AsString();
    }

    private static string CategoryOf(Element e) => e.Category?.Name ?? "(tanpa kategori)";

    private static string LevelNameOf(Document doc, Element e)
    {
        var id = LevelResolver.Resolve(e);
        if (id == ElementId.InvalidElementId) return "—";
        return doc.GetElement(id)?.Name ?? "—";
    }

    /// <summary>Koordinat dalam mm — satuan internal Revit adalah feet.</summary>
    private static string PositionOf(Element e)
    {
        if (e.Location is LocationPoint point)
        {
            var p = point.Point;
            return $"X {p.X * 304.8:N0} · Y {p.Y * 304.8:N0} · Z {p.Z * 304.8:N0} mm";
        }

        if (e.Location is LocationCurve curve)
        {
            var mid = curve.Curve.Evaluate(0.5, true);
            return $"X {mid.X * 304.8:N0} · Y {mid.Y * 304.8:N0} · Z {mid.Z * 304.8:N0} mm (tengah)";
        }

        return "—";
    }
}
