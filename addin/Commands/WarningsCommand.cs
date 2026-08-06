using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /warnings — rekap warning aktif di model.
///
/// Dikelompokkan per jenis, bukan dilaporkan satu per satu: model elektrikal
/// yang sehat pun bisa punya ratusan baris warning, dan daftar mentah sepanjang
/// itu melewati batas 4096 karakter Telegram sekaligus tidak terbaca. Yang
/// berguna dari jarak jauh adalah "jenis apa, berapa banyak".
/// </summary>
public sealed class WarningsCommand : IBotCommand
{
    /// <summary>Jenis warning terbanyak yang ditampilkan; sisanya diringkas.</summary>
    private const int MaxGroups = 15;

    public string Name => "warnings";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var warnings = doc.GetWarnings();
        if (warnings.Count == 0) return ExecResult.Success("Tidak ada warning aktif di model ini.");

        var groups = warnings
            .GroupBy(w => w.GetDescriptionText())
            .OrderByDescending(g => g.Count())
            .ToList();

        var sb = new StringBuilder();
        sb.AppendLine($"{warnings.Count} warning · {groups.Count} jenis");
        sb.AppendLine();

        foreach (var group in groups.Take(MaxGroups))
        {
            // Deskripsi warning Revit bisa satu kalimat panjang. Dipotong di
            // sini, bukan di sisi Telegram, supaya jumlahnya tetap terbaca.
            var text = group.Key.Length > 68 ? group.Key[..67] + "…" : group.Key;
            sb.AppendLine($"{group.Count(),4}  {text}");
        }

        if (groups.Count > MaxGroups)
        {
            var rest = groups.Skip(MaxGroups).Sum(g => g.Count());
            sb.AppendLine();
            sb.AppendLine($"…{groups.Count - MaxGroups} jenis lain ({rest} warning) tidak ditampilkan.");
        }

        return ExecResult.Success(sb.ToString().TrimEnd());
    }
}
