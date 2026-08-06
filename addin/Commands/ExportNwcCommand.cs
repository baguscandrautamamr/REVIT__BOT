using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /nwc — export model ke NWC untuk Navisworks.
///
/// Satu-satunya command di sini yang bergantung pada software LAIN: format NWC
/// ditulis oleh "Navisworks Exporters" milik Autodesk, sebuah add-in terpisah
/// yang harus dipasang di PC Revit. Tanpa itu Revit melempar exception yang
/// tidak menyebut penyebabnya sama sekali — jadi ia diterjemahkan di sini.
/// </summary>
public sealed class ExportNwcCommand : IBotCommand
{
    public string Name => "nwc";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        // View 3D dipakai sebagai lingkup export. Tanpa view, Navisworks
        // mengekspor "seluruh model" termasuk yang tersembunyi, dan hasilnya
        // jauh lebih besar tanpa lebih berguna.
        var view3d = new FilteredElementCollector(doc)
            .OfClass(typeof(View3D))
            .Cast<View3D>()
            .Where(v => !v.IsTemplate)
            .OrderByDescending(v => v.Name.Contains("nav", StringComparison.OrdinalIgnoreCase))
            .ThenBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();

        if (view3d is null)
            return ExecResult.Fail("Tidak ada view 3D di model ini, jadi tidak ada yang bisa diekspor ke NWC.");

        using var workspace = new ExportWorkspace("nwc");

        var fileName = $"{ExportWorkspace.Sanitize(doc.Title)}_{ExportWorkspace.Stamp()}";

        var options = new NavisworksExportOptions
        {
            ExportScope = NavisworksExportScope.View,
            ViewId = view3d.Id,
            ExportLinks = false,
            ConvertElementProperties = true,
            Coordinates = NavisworksCoordinates.Shared,
        };

        try
        {
            doc.Export(workspace.Folder, fileName, options);
        }
        catch (Exception ex)
        {
            // Pesan aslinya biasanya "The given export option is not supported"
            // atau exception dari exporter yang tidak ada — keduanya tidak
            // menuntun ke mana pun buat orang yang cuma mengetik /nwc.
            return ExecResult.Fail(
                "Export NWC gagal. Penyebab paling sering: add-in \"Navisworks Exporters\" " +
                "belum terpasang di PC Revit ini — formatnya ditulis oleh add-in Autodesk " +
                "yang terpisah, bukan oleh Revit sendiri. Unduh versi yang cocok dengan " +
                $"Revit 2025 dari akun Autodesk, pasang, lalu ulangi.\n\nPesan asli: {ex.Message}");
        }

        var file = workspace.Collect("nwc", $"{fileName}.zip");
        if (file is null)
            return ExecResult.Fail("Export selesai tapi berkas NWC tidak ditemukan — kemungkinan exporter-nya tidak terpasang.");

        var mb = file.Value.Bytes.Length / 1024.0 / 1024.0;
        return ExecResult.WithFile($"{doc.Title}\nDari view: {view3d.Name} · {mb:N1} MB", file.Value.Name, file.Value.Bytes);
    }
}
