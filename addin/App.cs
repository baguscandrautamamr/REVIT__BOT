using Autodesk.Revit.UI;
using RevitTelegramBridge.Events;
using RevitTelegramBridge.Polling;
using RevitTelegramBridge.Services;

namespace RevitTelegramBridge;

/// <summary>
/// Titik masuk add-in. Nol klik: worker nyala sendiri dari OnStartup dan mati
/// di OnShutdown. Tidak ada ribbon, tidak ada tombol yang harus ditekan.
/// </summary>
public sealed class App : IExternalApplication
{
    private static ExternalEvent? _externalEvent;
    private static CommandHandler? _handler;
    private static QueueWorker? _worker;

    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            _handler = new CommandHandler();

            // ExternalEvent adalah satu-satunya jembatan sah dari thread
            // polling ke main thread Revit. Tanpa ini, Revit crash acak —
            // kadang setelah berjam-jam, tanpa jejak di log.
            _externalEvent = ExternalEvent.Create(_handler);

            var token = TokenStore.Load();
            if (string.IsNullOrWhiteSpace(token))
            {
                // Tanpa token, jangan diam-diam gagal setiap 4 detik.
                TaskDialog.Show(
                    "Revit Telegram Bridge",
                    "Machine token belum dipasang, jadi bot tidak akan mengambil job.\n\n" +
                    "Jalankan sekali di Windows PowerShell:\n" +
                    "  .\\set-token.ps1 -Token \"<MACHINE_TOKEN>\"\n\n" +
                    "lalu tutup dan buka lagi Revit.");
                return Result.Succeeded;
            }

            _worker = new QueueWorker(_externalEvent, _handler);
            _worker.Start();
        }
        catch (Exception ex)
        {
            // Add-in yang melempar exception di OnStartup membuat Revit
            // menampilkan dialog dan menonaktifkannya. Lebih baik gagal
            // dengan tenang dan tetap membiarkan orang bekerja.
            Log.Error("OnStartup", ex);
        }

        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        // Tanpa Cancel(), thread polling terus hidup setelah Revit ditutup dan
        // menahan proses tetap berjalan di Task Manager.
        //
        // ExternalEvent dibuang SETELAH loop berhenti, bukan di baris ini. Loop
        // memanggil Raise() di setiap siklus polling, jadi membuangnya sekarang
        // — selagi siklus terakhir mungkin masih menunggu HTTP — melempar
        // exception di thread latar tepat ketika Revit sedang menutup diri.
        var externalEvent = _externalEvent;
        _externalEvent = null;

        if (_worker is not null) _worker.Stop(() => externalEvent?.Dispose());
        else externalEvent?.Dispose();

        return Result.Succeeded;
    }
}
