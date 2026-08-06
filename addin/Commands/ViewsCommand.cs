using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /views — daftar view 3D beserta perintah /png siap salin.
///
/// Alasannya sama persis dengan /series: nama view hanya tertulis di browser
/// tree Revit — di PC — sementara yang meminta gambarnya sedang memegang HP.
/// Tanpa command ini, `/png "…"` cuma bisa dipakai orang yang sudah duduk di
/// depan Revit, yaitu justru orang yang tidak butuh bot.
///
/// Daftar yang sama memang sudah muncul ketika /png GAGAL. Tapi mengandalkan
/// kegagalan untuk mendapat informasi berarti orangnya harus salah dulu sebelum
/// boleh tahu — dan ia tidak punya cara menebak kata apa yang harus diketik
/// supaya gagalnya cukup informatif.
/// </summary>
public sealed class ViewsCommand : IBotCommand
{
    public string Name => "views";

    public ExecResult Run(Document doc, JsonElement payload) =>
        ExecResult.Success(Report(doc, payload.Str("filter"), payload.Flag("all")));

    /// <summary>
    /// Isi balasannya, tanpa judul.
    ///
    /// Dipisah supaya /png bisa memakai daftar YANG SAMA saat namanya tidak
    /// ditemukan. Dua salinan aturan berarti daftar di /views dan daftar di pesan
    /// gagal /png bisa menyimpang, dan yang satu menyebut view yang tidak disebut
    /// yang lain.
    /// </summary>
    internal static string Report(Document doc, string? filter, bool all)
    {
        var views3d = Filtered(ViewFinder.Views3D(doc).Select(v => v.Name), filter);

        if (!all)
        {
            if (views3d.Count == 0)
            {
                return string.IsNullOrWhiteSpace(filter)
                    ? "Model ini tidak punya satu pun view 3D.\n\nSemua jenis view: /views --all"
                    : $"Tidak ada view 3D yang cocok dengan \"{filter}\".\n\nSemua view 3D: /views";
            }

            var sb = new StringBuilder();
            sb.AppendLine(string.IsNullOrWhiteSpace(filter)
                ? $"{views3d.Count} view 3D"
                : $"{views3d.Count} view 3D cocok dengan \"{filter}\"");
            sb.AppendLine();

            // Perintahnya ditempel di bawah tiap nama, SELALU dalam tanda kutip.
            // Nama view di proyek ini mengandung spasi, koma, dan kurung —
            // "E-COMMUNICATION, DATA & TELEPHONE DEVICES" — dan tanpa kutip ia
            // pecah jadi banyak kata sebelum sempat dicari.
            foreach (var name in views3d)
            {
                foreach (var line in Layout.Wrap(name, Layout.Width)) sb.AppendLine(line);
                sb.AppendLine($"  /png \"{name}\"");
                sb.AppendLine();
            }

            sb.Append("Jenis view lain (sheet, denah, drafting): /views --all");
            return sb.ToString();
        }

        // `--all`: TANPA perintah per baris. Satu proyek bisa punya puluhan
        // drafting view standar, dan dua baris per view membuat balasannya
        // beberapa layar penuh untuk daftar yang cuma perlu dipindai.
        var sheets = Filtered(ViewFinder.Sheets(doc).Select(s => s.SheetNumber), filter);
        var others = Filtered(
            ViewFinder.Printable(doc).Where(v => v is not ViewSheet and not View3D).Select(v => v.Name),
            filter);

        if (views3d.Count + sheets.Count + others.Count == 0)
        {
            return string.IsNullOrWhiteSpace(filter)
                ? "Tidak ada view yang bisa diekspor di model ini."
                : $"Tidak ada view yang cocok dengan \"{filter}\".";
        }

        var body = ViewFinder.SuggestGroups(
            12,
            ("View 3D", views3d),
            ("Sheet", sheets),
            ("View lain", others));

        var example = views3d.Count > 0 ? views3d[0] : (others.Count > 0 ? others[0] : "NAMA VIEW");
        return $"{body}\n\nNama berspasi HARUS dikutip:\n/png \"{example}\"";
    }

    private static List<string> Filtered(IEnumerable<string> names, string? filter) =>
        names
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Where(n => string.IsNullOrWhiteSpace(filter) ||
                        n.Contains(filter, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
            .ToList();
}
