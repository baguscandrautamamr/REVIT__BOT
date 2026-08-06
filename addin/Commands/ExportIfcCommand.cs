using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /ifc — export seluruh model ke IFC.
///
/// Lambat dan besar, dan itu sifatnya: IFC membawa seluruh geometri beserta
/// propertinya. Pada model elektrikal satu gedung, hitungan menit adalah
/// normal, bukan tanda ada yang salah.
/// </summary>
public sealed class ExportIfcCommand : IBotCommand
{
    public string Name => "ifc";

    public ExecResult Run(Document doc, JsonElement payload)
    {
        using var workspace = new ExportWorkspace("ifc");

        var fileName = $"{ExportWorkspace.Sanitize(doc.Title)}_{ExportWorkspace.Stamp()}.ifc";

        var options = new IFCExportOptions
        {
            // IFC2x3 Coordination View 2.0: yang paling luas diterima software
            // penerima. IFC4 lebih baru tapi masih sering ditolak viewer lama,
            // dan yang menerima berkas ini bukan kita.
            FileVersion = IFCVersion.IFC2x3CV2,
            ExportBaseQuantities = true,
            WallAndColumnSplitting = false,
        };

        // Exporter IFC WAJIB dipanggil di dalam transaksi — ia menulis data
        // sementara ke dokumen selama bekerja. Transaksinya di-RollBack, bukan
        // Commit: kita mengekspor, bukan mengubah model orang. Tanpa rollback,
        // /ifc meninggalkan perubahan di file kerja yang sedang dipakai orang
        // lain, dan tidak ada yang tahu dari mana asalnya.
        using var tx = new Transaction(doc, "Export IFC (Telegram)");
        tx.Start();
        try
        {
            doc.Export(workspace.Folder, fileName, options);
        }
        finally
        {
            tx.RollBack();
        }

        var file = workspace.Collect("ifc", $"{fileName}.zip");
        if (file is null) return ExecResult.Fail("Export selesai tapi berkas IFC tidak ditemukan.");

        var mb = file.Value.Bytes.Length / 1024.0 / 1024.0;
        return ExecResult.WithFile($"{doc.Title}\nIFC2x3 CV2 · {mb:N1} MB", file.Value.Name, file.Value.Bytes);
    }
}
