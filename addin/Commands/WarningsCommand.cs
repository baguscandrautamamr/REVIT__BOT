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
            // Deskripsi warning Revit adalah kalimat, kadang dua. Dulu dipotong
            // di huruf ke-68 — dan yang terpotong justru bagian yang menjelaskan
            // APA yang salah, karena Revit menaruh subjeknya di depan dan
            // akibatnya di belakang. Sekarang dibungkus: angkanya tetap rata di
            // kolom kiri, kalimatnya utuh sampai habis.
            Layout.Hanging(sb, group.Count().ToString(), group.Key, 6);
            sb.AppendLine();
        }

        if (groups.Count > MaxGroups)
        {
            var rest = groups.Skip(MaxGroups).Sum(g => g.Count());
            sb.AppendLine($"…{groups.Count - MaxGroups} jenis lain ({rest} warning) tidak ditampilkan.");
        }

        return ExecResult.Success(sb.ToString().TrimEnd());
    }
}
