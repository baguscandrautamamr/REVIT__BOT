using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /levels — daftar level beserta elevasi.
///
/// Command yang paling sering dipakai duluan: tanpa nama level yang persis,
/// `/count` dan `/tray` akan meleset dan orang menyalahkan botnya.
/// </summary>
public sealed class LevelsCommand : IBotCommand
{
    public string Name => "levels";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var levels = new FilteredElementCollector(doc)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(l => l.Elevation)
            .ToList();

        if (levels.Count == 0) return ExecResult.Fail("Tidak ada level di model ini.");

        var sb = new StringBuilder();
        var width = levels.Max(l => l.Name.Length);

        foreach (var level in levels)
        {
            // Revit menyimpan panjang dalam feet internal. 304.8 mm per feet.
            var mm = level.Elevation * 304.8;
            sb.AppendLine($"{level.Name.PadRight(width)}  {mm,10:N0} mm");
        }

        sb.AppendLine();
        sb.Append($"{levels.Count} level");

        return ExecResult.Success(sb.ToString());
    }
}
