using Autodesk.Revit.UI;
using RevitTelegramBridge.Events;
using RevitTelegramBridge.Services;

namespace RevitTelegramBridge.Polling;

/// <summary>
/// Loop polling di background thread.
///
/// ATURAN MUTLAK: kelas ini TIDAK PERNAH menyentuh Revit API. Ia hanya
/// melakukan HTTP dan menitipkan payload ke handler, lalu memanggil
/// ExternalEvent.Raise(). Satu pemanggilan Revit API dari sini sudah cukup
/// untuk membuat Revit crash acak — dan crash-nya tidak menunjuk ke sini.
/// </summary>
public sealed class QueueWorker
{
    private const int BusyIntervalMs = 4_000;
    private const int IdleIntervalMs = 15_000;

    /// <summary>Setelah sekian siklus tanpa job, polling melambat.</summary>
    private const int IdleAfterCycles = 15;

    private readonly ExternalEvent _externalEvent;
    private readonly CommandHandler _handler;
    private readonly CancellationTokenSource _cts = new();

    private Task? _loop;
    private bool _stopped;

    public QueueWorker(ExternalEvent externalEvent, CommandHandler handler)
    {
        _externalEvent = externalEvent;
        _handler = handler;
    }

    public void Start() => _loop = Task.Run(() => LoopAsync(_cts.Token));

    /// <summary>
    /// Dipanggil dari OnShutdown, jadi TIDAK boleh memblokir: Revit sedang
    /// menutup diri dan loop-nya mungkin masih menunggu HTTP sampai 30 detik.
    ///
    /// Dispose sengaja ditunda sampai loop benar-benar keluar. Membuang
    /// CancellationTokenSource sementara token-nya masih dipegang `Task.Delay`
    /// melempar ObjectDisposedException di thread latar — exception yang muncul
    /// tepat saat Revit ditutup, jadi mudah sekali disalahartikan sebagai
    /// add-in yang membuat Revit crash saat keluar.
    /// </summary>
    public void Stop()
    {
        if (_stopped) return;
        _stopped = true;

        _cts.Cancel();

        if (_loop is null) _cts.Dispose();
        else _loop.ContinueWith(_ => _cts.Dispose(), TaskScheduler.Default);
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        Log.Info("worker start");
        var idleCycles = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                // Kalau job sebelumnya masih dikerjakan di main thread, jangan
                // ambil yang baru — hasilnya akan saling menimpa.
                if (_handler.IsBusy)
                {
                    await Task.Delay(BusyIntervalMs, ct);
                    continue;
                }

                var info = new HeartbeatInfo
                {
                    // Nilai ini di-cache oleh handler saat eksekusi terakhir.
                    // Membacanya langsung dari Revit di sini = pelanggaran
                    // aturan thread di atas.
                    ActiveDoc = _handler.LastKnownDocTitle,
                    RevitVersion = _handler.RevitVersion,
                    AddinVersion = typeof(QueueWorker).Assembly.GetName().Version?.ToString(),
                };

                var response = await BridgeClient.ClaimAsync(info, ct);

                if (response?.Job is { } job)
                {
                    idleCycles = 0;
                    _handler.Enqueue(job);
                    _externalEvent.Raise();   // eksekusi pindah ke main thread
                }
                else
                {
                    idleCycles++;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                // Tanpa catch di dalam loop, wifi putus sebentar = worker mati
                // diam-diam. Revit tetap terbuka, bot tetap "seharusnya jalan",
                // dan tidak ada yang tahu sampai ada yang mengeluh.
                Log.Error("worker loop", ex);
                idleCycles++;
            }

            var delay = idleCycles >= IdleAfterCycles ? IdleIntervalMs : BusyIntervalMs;
            try { await Task.Delay(delay, ct); }
            catch (OperationCanceledException) { break; }
        }

        Log.Info("worker stop");
    }
}
