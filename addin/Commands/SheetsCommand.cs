using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitTelegramBridge.Services;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /sheets [filter] — daftar sheet beserta revisi terakhir.
/// /sheets --groups — daftar grup ACT SHEET SERIES beserta isinya.
/// </summary>
public sealed class SheetsCommand : IBotCommand
{
    public string Name => "sheets";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        // Daftar grup punya command sendiri sekarang: /series. Flag ini tetap ada
        // supaya yang sudah terbiasa memakainya tidak patah, dan ia MENDELEGASI —
        // dua salinan aturan pengelompokan berarti "grup" bisa berarti dua hal
        // berbeda tergantung command mana yang dipakai.
        if (payload.Flag("groups")) return SeriesCommand.Report(doc, payload.Str("filter"), detail: true);

        var filter = payload.Str("filter");

        var sheets = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsTemplate)
            .Where(s => string.IsNullOrWhiteSpace(filter)
                        || s.SheetNumber.Contains(filter, StringComparison.OrdinalIgnoreCase)
                        || s.Name.Contains(filter, StringComparison.OrdinalIgnoreCase))
            .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (sheets.Count == 0)
            return ExecResult.Success(string.IsNullOrWhiteSpace(filter)
                ? "Tidak ada sheet di model ini."
                : $"Tidak ada sheet yang cocok dengan \"{filter}\".");

        var sb = new StringBuilder();

        // Jumlahnya di ATAS. Di bawah, ia baru terbaca setelah menggulir seluruh
        // daftarnya — padahal itu justru angka yang menentukan apakah daftarnya
        // perlu digulir sama sekali.
        sb.AppendLine(string.IsNullOrWhiteSpace(filter)
            ? $"{sheets.Count} sheet"
            : $"{sheets.Count} sheet cocok dengan \"{filter}\"");
        sb.AppendLine();

        // Nomor sheet di barisnya sendiri, NAMANYA di bawahnya.
        //
        // Sebelumnya keduanya dijejalkan ke satu baris dengan nama dipotong di
        // huruf ke-30, dan yang hilang persis bagian yang membedakan satu sheet
        // dari sheet lain: "GROUND & FIRST FLOOR – LIGHTI…" dan
        // "GROUND & FIRST FLOOR – EMERGE…" terbaca nyaris sama. Sekarang nama
        // dapat seluruh lebar baris dan dibungkus kalau perlu — tidak ada lagi
        // yang dibuang.
        foreach (var sheet in sheets)
        {
            var revision = LatestRevision(doc, sheet);
            var head = revision is null ? sheet.SheetNumber : $"{sheet.SheetNumber}  ·  rev {revision}";
            Layout.Entry(sb, head, sheet.Name);
        }

        return ExecResult.Success(sb.ToString().TrimEnd());
    }

    /// <summary>
    /// Nomor revisi terakhir pada satu sheet.
    ///
    /// Nomornya dibaca lewat SHEET-nya, bukan lewat objek Revision. Kalau
    /// "revision numbering" model di-set per sheet, `Revision.RevisionNumber`
    /// melempar InvalidOperationException:
    ///
    ///   This operation is not valid for when the revision numbering is per sheet.
    ///
    /// Karena dipanggil di dalam loop, satu model seperti itu membuat SELURUH
    /// /sheets gagal — bukan cuma kolom revisinya yang kosong. Itu benar-benar
    /// terjadi di lapangan. `GetRevisionNumberOnSheet` sah untuk kedua mode
    /// penomoran dan mengembalikan angka yang persis tercetak di sheet.
    /// </summary>
    /// <summary>null = sheet ini memang belum punya revisi.</summary>
    private static string? LatestRevision(Document doc, ViewSheet sheet)
    {
        var ids = sheet.GetAllRevisionIds();
        if (ids.Count == 0) return null;

        // GetAllRevisionIds mengembalikan urutan sesuai urutan revisi di model;
        // yang terakhir adalah yang terbaru.
        var id = ids[^1];

        try
        {
            var onSheet = sheet.GetRevisionNumberOnSheet(id);
            if (!string.IsNullOrWhiteSpace(onSheet)) return onSheet;
        }
        catch (Exception ex)
        {
            Log.Warn($"nomor revisi sheet {sheet.SheetNumber}: {ex.GetType().Name}: {ex.Message}");
        }

        // Cadangan: revisi yang tidak tampil di sheet (mis. sudah di-issue dan
        // disembunyikan) tetap punya nomor di tingkat project. SequenceNumber
        // selalu sah, apa pun mode penomorannya — jadi ia jadi jaring terakhir
        // supaya satu sheet aneh tidak menjatuhkan seluruh daftar.
        if (doc.GetElement(id) is not Revision revision) return null;
        try
        {
            return revision.RevisionNumber;
        }
        catch (InvalidOperationException)
        {
            return $"#{revision.SequenceNumber}";
        }
    }
}
