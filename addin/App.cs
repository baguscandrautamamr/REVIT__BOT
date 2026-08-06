using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
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
    private static UIControlledApplication? _ui;

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

            // Versi Revit sudah pasti sekarang — tidak perlu menunggu dokumen
            // apalagi job. Sebelumnya ia baru terisi saat command pertama
            // jalan, jadi /status menulis "Revit: —" untuk PC yang jelas-jelas
            // sedang membuka Revit.
            _handler.NoteRevitVersion(application.ControlledApplication.VersionNumber);

            // Judul dokumen ikut ketiga event ini, bukan dibaca dari thread
            // polling — memanggil Revit API dari sana adalah crash acak yang
            // menunggu waktu. ViewActivated menangani buka dokumen dan pindah
            // antar-dokumen; DocumentOpened menutup celah dokumen yang terbuka
            // tanpa view aktif; DocumentClosing membersihkan saat yang terakhir
            // ditutup, sebab tidak ada event "view dinonaktifkan".
            _ui = application;
            application.ViewActivated += OnViewActivated;
            application.ControlledApplication.DocumentOpened += OnDocumentOpened;
            application.ControlledApplication.DocumentClosing += OnDocumentClosing;

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
        if (_ui is not null)
        {
            _ui.ViewActivated -= OnViewActivated;
            _ui.ControlledApplication.DocumentOpened -= OnDocumentOpened;
            _ui.ControlledApplication.DocumentClosing -= OnDocumentClosing;
            _ui = null;
        }

        // Tanpa Cancel(), thread polling terus hidup setelah Revit ditutup dan
        // menahan proses tetap berjalan di Task Manager.
        _worker?.Stop();
        _externalEvent?.Dispose();
        return Result.Succeeded;
    }

    /* ── Event Revit: semuanya main thread ───────────────────────────────── */

    private static void OnViewActivated(object? sender, ViewActivatedEventArgs e)
        => _handler?.NoteActiveDocument(e.CurrentActiveView?.Document);

    private static void OnDocumentOpened(object? sender, DocumentOpenedEventArgs e)
        => _handler?.NoteActiveDocument(e.Document);

    private static void OnDocumentClosing(object? sender, DocumentClosingEventArgs e)
        => _handler?.NoteDocumentClosing(e.Document);
}
