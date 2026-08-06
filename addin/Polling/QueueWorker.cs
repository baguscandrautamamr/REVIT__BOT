using System.Reflection;
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

    /// <summary>
    /// Versi yang dilaporkan ke server — yang muncul sebagai "Add-in" di
    /// /status dan di panel web.
    ///
    /// Dibaca dari AssemblyInformationalVersion, BUKAN GetName().Version.
    /// `GetName().Version` mengembalikan AssemblyVersion, yang selalu empat
    /// angka: MSBuild membuang suffix prerelease-nya. Build harian CI yang
    /// ditandai `0.1.0-dev.42` jadi terbaca `0.1.0.0` dan tidak bisa dibedakan
    /// dari rilis 0.1.0 — persis yang ingin dicegah penomoran di workflow.
    ///
    /// SDK menempelkan `+&lt;commit sha&gt;` di belakangnya; itu dipotong karena
    /// tidak ada gunanya di layar HP.
    /// </summary>
    private static readonly string? AddinVersion =
        typeof(QueueWorker).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0]
        ?? typeof(QueueWorker).Assembly.GetName().Version?.ToString();

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
    /// Pembuangan sengaja ditunda sampai loop benar-benar keluar. Membuang
    /// CancellationTokenSource sementara token-nya masih dipegang `Task.Delay`
    /// melempar ObjectDisposedException di thread latar — exception yang muncul
    /// tepat saat Revit ditutup, jadi mudah sekali disalahartikan sebagai
    /// add-in yang membuat Revit crash saat keluar.
    /// </summary>
    /// <param name="afterStopped">
    /// Dijalankan setelah loop benar-benar berhenti. Dipakai App untuk membuang
    /// ExternalEvent: loop memanggil Raise() di SETIAP siklus, jadi membuang
    /// event-nya selagi siklus terakhir masih berjalan menimbulkan exception
    /// yang persis sama seperti di atas.
    /// </param>
    public void Stop(Action? afterStopped = null)
    {
        if (_stopped) return;
        _stopped = true;

        _cts.Cancel();

        void Cleanup()
        {
            _cts.Dispose();
            try { afterStopped?.Invoke(); }
            catch (Exception ex) { Log.Error("QueueWorker.Stop", ex); }
        }

        if (_loop is null) Cleanup();
        else _loop.ContinueWith(_ => Cleanup(), TaskScheduler.Default);
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
                // ambil yang baru — hasilnya akan saling menimpa. Tapi TETAP
                // hubungi server: claim merangkap heartbeat, dan berhenti
                // memanggilnya selama job berjalan membuat `last_seen_at` basi.
                // Ambang online cuma 30 detik, jadi satu export PDF satu menit
                // sudah cukup untuk membuat /status melapor "PC offline" tepat
                // ketika PC-nya justru sedang bekerja.
                var busy = _handler.IsBusy;

                var info = new HeartbeatInfo
                {
                    // Nilai ini di-cache oleh handler saat Execute terakhir.
                    // Membacanya langsung dari Revit di sini = pelanggaran
                    // aturan thread di atas.
                    ActiveDoc = _handler.LastKnownDocTitle,
                    RevitVersion = _handler.RevitVersion,
                    AddinVersion = AddinVersion,
                    Busy = busy,
                };

                var response = await BridgeClient.ClaimAsync(info, ct);

                if (response?.Job is { } job)
                {
                    idleCycles = 0;
                    _handler.Enqueue(job);
                }
                else
                {
                    idleCycles++;
                }

                // Raise SELALU, bukan hanya ketika ada job.
                //
                // `ActiveDoc` dan `RevitVersion` hanya boleh dibaca dari main
                // thread, jadi keduanya di-cache handler saat Execute berjalan.
                // Selama Raise() cuma dipanggil ketika ada job, cache itu tidak
                // pernah terisi sampai job PERTAMA selesai: /status dan panel
                // web menampilkan "—" untuk Revit dan Model padahal PC-nya
                // online. Sesudahnya pun nilainya membeku di model lama walau
                // orangnya sudah membuka project lain — dan itu berbahaya,
                // sebab judul model inilah yang dipakai server untuk mengunci
                // job ke project yang benar (`expectedDocTitle`).
                //
                // Raise dengan antrean kosong tidak mengerjakan apa pun selain
                // menyegarkan kedua nilai itu, dan Revit menjalankannya saat
                // idle — tidak ada yang tertahan.
                if (!ct.IsCancellationRequested) _externalEvent.Raise();
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
