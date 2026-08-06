using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /series — daftar grup sheet beserta perintah export siap salin.
///
/// Ada supaya nama grup bisa diketahui TANPA membuka Revit. Nama itu hanya
/// tertulis di browser tree — di PC — sementara yang meminta gambarnya sedang
/// memegang HP. Tanpa command ini, `/pdf --series "…"` hanya bisa dipakai orang
/// yang sudah duduk di depan Revit, yaitu justru orang yang tidak butuh bot.
///
/// Command sendiri, bukan flag. `/sheets --groups` sudah melakukan hal yang sama
/// dan tetap bekerja, tapi flag menuntut dua tanda hubung yang diketik benar —
/// dan papan ketik ponsel mengubahnya jadi em dash secara otomatis. Command yang
/// muncul di menu "/" Telegram bisa DITEKAN, jadi tidak ada yang bisa salah ketik.
/// </summary>
public sealed class SeriesCommand : IBotCommand
{
    public string Name => "series";

    public ExecResult Run(Document doc, JsonElement payload) =>
        Report(doc, payload.Str("filter"), payload.Flag("detail"));

    /// <summary>
    /// Daftar grup. `detail` menambahkan nomor + nama tiap sheet di dalamnya.
    ///
    /// Ringkas jadi default karena inilah yang ditanyakan orang sembilan dari
    /// sepuluh kali: "grupnya apa saja, dan perintahnya bagaimana". Daftar 25
    /// sheet lengkap menjawab pertanyaan yang tidak diajukan, dan mendorong
    /// jawabannya keluar dari satu layar ponsel.
    /// </summary>
    internal static ExecResult Report(Document doc, string? discipline, bool detail)
    {
        var index = SheetGroups.Build(doc, discipline);
        if (index is null)
        {
            return ExecResult.Fail(
                $"Model ini tidak punya parameter \"{SheetGroups.SeriesParam}\" di sheet-nya, " +
                "jadi tidak ada yang bisa dikelompokkan.\n\n" +
                $"Parameter yang ADA di sheet:\n{SheetGroups.ParameterNames(doc)}");
        }

        if (index.Groups.Count == 0)
        {
            var available = SheetGroups.Disciplines(doc);
            return ExecResult.Fail(
                (discipline is null
                    ? "Tidak ada grup yang terbentuk."
                    : $"Tidak ada sheet dengan {SheetGroups.DisciplineParam} = \"{discipline}\".") +
                (available.Count == 0 ? "" : "\n\nDiscipline yang ada:\n" +
                    string.Join("\n", available.Select(d => "· " + d))) +
                index.Notes());
        }

        var sb = new StringBuilder();
        var disciplines = SheetGroups.Disciplines(doc);

        sb.AppendLine($"{index.Groups.Count} grup · {index.SheetCount} sheet");
        sb.AppendLine(disciplines.Count switch
        {
            0 => $"{SheetGroups.DisciplineParam}: (kosong)",
            1 => $"{SheetGroups.DisciplineParam}: {disciplines[0]}",
            _ => $"{SheetGroups.DisciplineParam}: {string.Join(", ", disciplines)}",
        });
        sb.AppendLine();

        foreach (var group in index.Groups)
        {
            Layout.Row(sb, group.Key, $"{group.Sheets.Count,3} sheet", Layout.Width - 10);

            if (detail)
            {
                foreach (var sheet in group.Sheets)
                {
                    Layout.Entry(sb, "  " + sheet.SheetNumber, sheet.Name, "      ");
                }
            }

            // Perintahnya ditempel di bawah tiap grup, lengkap dengan tanda kutip.
            // Balasan add-in dikirim sebagai blok kode, jadi baris ini bisa disalin
            // apa adanya — dan yang tersalin adalah "--" ASCII, bukan em dash.
            sb.AppendLine($"  /pdf --series \"{group.Key}\"");
            sb.AppendLine();
        }

        // Nama grup terpanjang menentukan apakah perintahnya perlu tanda kutip.
        // Disebut sekali di bawah, bukan diulang per grup.
        sb.AppendLine("Salin baris /pdf di atas apa adanya — tanda kutipnya perlu");
        sb.Append("kalau nama grupnya mengandung spasi.");

        if (!detail) sb.Append("\nDaftar sheet per grup: /sheets --groups");

        sb.Append(index.Notes());
        return ExecResult.Success(sb.ToString().TrimEnd());
    }
}
