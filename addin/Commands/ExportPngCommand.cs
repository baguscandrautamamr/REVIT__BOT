using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /png &lt;view&gt; — export satu view jadi gambar PNG.
///
/// Untuk dilihat di HP, bukan untuk dicetak: yang diminta orang dari command
/// ini hampir selalu "coba lihat bentuknya" — dan PDF di layar HP jauh lebih
/// merepotkan daripada gambar yang langsung tampil di chat.
/// </summary>
public sealed class ExportPngCommand : IBotCommand
{
    /// <summary>
    /// Lebar gambar dalam piksel.
    ///
    /// 2400 px kira-kira setara 150 DPI untuk kertas A1 — cukup untuk membaca
    /// nomor panel dan label kabel saat di-zoom di HP, dan masih di bawah batas
    /// kompresi foto Telegram karena dikirim sebagai dokumen, bukan foto.
    /// </summary>
    private const int WidthPixels = 2400;

    public string Name => "png";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        var wanted = payload.Str("view");
        if (string.IsNullOrWhiteSpace(wanted)) return ExecResult.Fail("Nama view belum disebutkan.");

        // Sheet ikut dicari: /png sering dipakai untuk sheet yang sama dengan
        // /pdf, dan menolaknya hanya karena "itu sheet, bukan view" tidak
        // menolong siapa pun.
        View? view = ViewFinder.Sheet(doc, wanted);
        view ??= ViewFinder.View(doc, wanted);

        if (view is null)
        {
            var names = ViewFinder.Sheets(doc).Select(s => $"{s.SheetNumber} — {s.Name}")
                .Concat(ViewFinder.Printable(doc).Where(v => v is not ViewSheet).Select(v => v.Name));
            return ExecResult.Fail($"View \"{wanted}\" tidak ditemukan.\n\nYang bisa dipakai:\n{ViewFinder.Suggest(names)}");
        }

        if (!view.CanBePrinted)
            return ExecResult.Fail($"View \"{view.Name}\" tidak bisa diekspor jadi gambar (schedule/legend).");

        using var workspace = new ExportWorkspace("png");

        var baseName = $"{ExportWorkspace.Sanitize(doc.Title)}_{ExportWorkspace.Sanitize(view.Name)}_{ExportWorkspace.Stamp()}";

        var options = new ImageExportOptions
        {
            // Revit MENAMBAHKAN tipe dan nama view ke belakang path ini, dengan
            // aturan yang berbeda-beda. Itu sebabnya hasilnya dicari dengan
            // melihat isi folder, bukan dengan menebak nama akhirnya.
            FilePath = Path.Combine(workspace.Folder, baseName),
            ExportRange = ExportRange.SetOfViews,
            HLRandWFViewsFileType = ImageFileType.PNG,
            ShadowViewsFileType = ImageFileType.PNG,
            ZoomType = ZoomFitType.FitToPage,
            PixelSize = WidthPixels,
            FitDirection = FitDirectionType.Horizontal,
            ImageResolution = ImageResolution.DPI_300,
            ShouldCreateWebSite = false,
        };
        options.SetViewsAndSheets(new List<ElementId> { view.Id });

        doc.ExportImage(options);

        var file = workspace.Collect("png", $"{baseName}.zip");
        if (file is null)
            return ExecResult.Fail("Export selesai tapi Revit tidak menghasilkan berkas PNG. Cek apakah view-nya kosong.");

        var mb = file.Value.Bytes.Length / 1024.0 / 1024.0;
        return ExecResult.WithFile($"{view.Name}\n{WidthPixels} px · {mb:N1} MB", file.Value.Name, file.Value.Bytes);
    }
}
