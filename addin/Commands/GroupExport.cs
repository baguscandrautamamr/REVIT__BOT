using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Jalur export per-grup, dipakai bersama /pdf dan /dwg.
///
/// Yang dikerjakan di sini adalah bagian yang identik untuk keduanya: membaca
/// permintaan grup dari payload, menerjemahkannya jadi daftar grup, mengekspor
/// satu berkas PER grup ke dalam SATU folder kerja, lalu menyusun kalimat
/// balasannya. Yang berbeda — opsi export dan format berkasnya — diserahkan ke
/// pemanggilnya lewat satu delegate.
///
/// Satu berkas per grup, bukan satu berkas untuk semuanya. Itu keputusan yang
/// membuat seluruh fitur ini ada gunanya: nama grup masuk ke nama berkas, jadi
/// "GENERAL-LV" dan "GENERAL-ELV" bisa dibedakan tanpa membukanya. Kalau grupnya
/// lebih dari satu, semuanya dibungkus satu zip — Telegram mengirim satu dokumen
/// per pesan.
/// </summary>
internal static class GroupExport
{
    /// <summary>
    /// Kerjakan permintaan per-grup, atau null kalau payload-nya BUKAN permintaan
    /// per-grup — dan pemanggilnya lanjut ke jalur daftar sheet biasa.
    /// </summary>
    /// <param name="exportOne">
    /// Ekspor satu grup ke dalam folder kerja. Nama berkasnya WAJIB memuat
    /// <c>group.Key</c>; itu satu-satunya yang membedakan hasil antar grup.
    /// Melempar exception kalau Revit menolak.
    /// </param>
    public static ExecResult? Run(
        Document doc,
        JsonElement payload,
        string extension,
        Action<Document, ExportWorkspace, SheetGroup, string> exportOne)
    {
        var series = payload.Str("series");
        var discipline = payload.Str("discipline");
        if (series is null && discipline is null) return null;

        // int.MaxValue kalau server tidak menyebutkan batasnya. Bukan "tanpa
        // batas" karena kelonggaran: add-in versi ini bisa saja menerima job dari
        // server versi lama yang belum mengirim `maxSheets`, dan menolak semuanya
        // dengan batas 0 akan mematikan fitur ini di tengah deploy.
        var maxSheets = payload.Int("maxSheets") ?? int.MaxValue;

        var selection = SheetGroups.Select(doc, series, discipline, maxSheets);
        if (!selection.Ok) return ExecResult.Fail(selection.Error!);

        using var workspace = new ExportWorkspace(extension);
        var prefix = ExportWorkspace.Sanitize(doc.Title);

        // LOKAL, bukan field. Handler ini hidup selama Revit terbuka dan
        // mengerjakan job demi job di objek yang sama — daftar yang disimpan di
        // luar pemanggilan akan membawa kegagalan job kemarin ke balasan job hari
        // ini, dan kalimatnya terlihat sama meyakinkannya.
        var failed = new List<(string Key, string Reason)>();

        foreach (var group in selection.Groups)
        {
            try
            {
                exportOne(doc, workspace, group, prefix);
            }
            catch (Exception ex)
            {
                // Satu grup yang gagal tidak boleh menjatuhkan yang lain — tapi
                // ia juga tidak boleh hilang diam-diam. Yang sudah jadi tetap
                // dikirim, dan yang gagal disebut namanya di balasan.
                Services.Log.Warn($"export grup {group.Key} gagal: {ex.GetType().Name}: {ex.Message}");
                failed.Add((group.Key, ex.Message));
            }
        }

        var zipName = $"{prefix}_{ExportWorkspace.Sanitize(selection.Label)}_{selection.Groups.Count}grup_{ExportWorkspace.Stamp()}.zip";
        var file = workspace.Collect(extension, zipName);
        if (file is null)
        {
            return ExecResult.Fail(
                $"Export selesai tapi tidak ada berkas {extension.ToUpperInvariant()} yang dihasilkan." +
                Failures(failed) + selection.Notes);
        }

        return ExecResult.WithFile(
            Summary(selection, failed, file.Value.Bytes.Length),
            file.Value.Name,
            file.Value.Bytes);
    }

    private static string Summary(
        GroupSelection selection, List<(string Key, string Reason)> problems, int bytes)
    {
        var sb = new StringBuilder();
        var sheets = selection.Groups.Sum(g => g.Sheets.Count);
        var mb = bytes / 1024.0 / 1024.0;

        sb.AppendLine($"{selection.Label} — {selection.Groups.Count} grup · {sheets} sheet · {mb:N1} MB");
        sb.AppendLine();

        // Isi tiap grup ikut disebut. Tanpa ini, satu zip berisi sepuluh berkas
        // memaksa membukanya dulu hanya untuk tahu apa yang ada di dalamnya —
        // dan di HP itu berarti tidak akan diperiksa sama sekali.
        foreach (var group in selection.Groups)
        {
            Layout.Row(sb, group.Key, $"{group.Sheets.Count,3} sheet", Layout.Width - 10);
            foreach (var sheet in group.Sheets) sb.AppendLine($"     {sheet.SheetNumber}");
        }

        sb.Append(Failures(problems));
        sb.Append(selection.Notes);
        return sb.ToString().TrimEnd();
    }

    private static string Failures(List<(string Key, string Reason)> problems) =>
        problems.Count == 0
            ? ""
            : "\nGagal diekspor: " + string.Join("; ", problems.Select(p => $"{p.Key} ({p.Reason})"));
}
