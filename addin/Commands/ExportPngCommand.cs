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
        var only3d = payload.Flag("only3d");

        // Tanpa nama sama sekali: langsung daftarkan view 3D-nya. Itu jawaban
        // yang lebih berguna daripada "nama view belum disebutkan" — nama-nama
        // itu memang tidak bisa ditebak, dan hanya ada di browser tree Revit.
        if (string.IsNullOrWhiteSpace(wanted)) return Choices(doc, null, only3d);

        var match = ViewFinder.FindForImage(doc, wanted, only3d);

        if (match.Kind == MatchKind.Ambiguous)
        {
            return ExecResult.Fail(
                $"\"{wanted}\" cocok ke {match.Candidates.Count} view sekaligus, jadi tidak ditebak.\n\n" +
                string.Join("\n", match.Candidates.Take(12).Select(n => "· " + n)) +
                (match.Candidates.Count > 12 ? $"\n…dan {match.Candidates.Count - 12} lagi" : "") +
                "\n\nSebut lebih lengkap, dalam tanda kutip:\n" +
                $"/png \"{match.Candidates[0]}\"");
        }

        var view = match.View;
        if (view is null) return Choices(doc, wanted, only3d);

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

    /// <summary>
    /// Apa saja yang bisa dipakai — dikelompokkan, dengan view 3D di paling atas.
    ///
    /// Urutannya bukan selera. Versi sebelumnya menumpuk semua nama jadi satu
    /// daftar alfabetis lalu memotongnya di lima belas, dan di proyek nyata
    /// seluruh jatah itu habis oleh drafting view bernama `**ACT STANDARDS**LINE
    /// WEIGHTS 1-…` — namanya diawali `*`, jadi selalu menang urutan. Sembilan
    /// view 3D yang justru dicari orangnya tidak muncul sekali pun, dan balasan
    /// yang gunanya menghapus tebakan malah memaksanya.
    /// </summary>
    private static ExecResult Choices(Document doc, string? wanted, bool only3d)
    {
        var views3d = ViewFinder.Views3D(doc);

        var head = wanted is null
            ? "Sebutkan view yang mau digambar."
            : $"View \"{wanted}\" tidak ditemukan.";

        if (views3d.Count == 0 && only3d)
            return ExecResult.Fail($"{head}\n\nModel ini tidak punya satu pun view 3D.");

        var groups = only3d
            ? new[] { ("View 3D", views3d.Select(v => v.Name)) }
            : new[]
            {
                ("View 3D", views3d.Select(v => v.Name)),
                ("Sheet", ViewFinder.Sheets(doc).Select(s => s.SheetNumber)),
                ("View lain", ViewFinder.Printable(doc)
                    .Where(v => v is not ViewSheet and not View3D)
                    .Select(v => v.Name)),
            };

        var example = views3d.Count > 0 ? views3d[0].Name : "NAMA VIEW";

        return ExecResult.Fail(
            $"{head}\n\n{ViewFinder.SuggestGroups(10, groups)}\n\n" +
            "Nama yang mengandung spasi HARUS dikutip:\n" +
            $"/png \"{example}\"\n" +
            "Cuma mau view 3D saja: /png --3d");
    }
}
