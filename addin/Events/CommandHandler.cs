using System.Collections.Concurrent;
using System.Diagnostics;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitTelegramBridge.Commands;
using RevitTelegramBridge.Services;

namespace RevitTelegramBridge.Events;

/// <summary>
/// Dijalankan di MAIN THREAD Revit lewat ExternalEvent. Di sinilah — dan hanya
/// di sini — Revit API boleh dipanggil.
/// </summary>
public sealed class CommandHandler : IExternalEventHandler
{
    private readonly ConcurrentQueue<JobDto> _pending = new();
    private readonly IReadOnlyDictionary<string, IBotCommand> _commands;

    private int _busy;

    public CommandHandler()
    {
        _commands = new IBotCommand[]
        {
            new LevelsCommand(),
            new SheetsCommand(),
            new SeriesCommand(),
            new ViewsCommand(),
            new WarningsCommand(),
            new CountByLevelCommand(),
            new TrayCommand(),
            new FindByMarkCommand(),
            new ExportPdfCommand(),
            new ExportScheduleCommand(),
            new ExportPngCommand(),
            new ExportDwgCommand(),
            new ExportIfcCommand(),
            new ExportNwcCommand(),
            new PanelCommand(),
            new ConnectedLoadCommand(),
        }.ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Dibaca worker: judul dokumen terakhir yang terlihat.</summary>
    public string? LastKnownDocTitle { get; private set; }

    public string? RevitVersion { get; private set; }

    /// <summary>
    /// Add-in masih MEMEGANG sebuah job — sedang dikerjakan, atau masih menunggu
    /// di antrean internal.
    ///
    /// Antrean ikut dihitung, dan itu bukan detail. Nilai ini dikirim ke server
    /// tiap heartbeat, dan server memakainya untuk memutuskan apakah sebuah baris
    /// `running` masih ada yang mengerjakan. Kalau hanya `_busy` yang dihitung,
    /// ada jendela nyata antara job diterima dari /claim dan ExternalEvent
    /// benar-benar jalan — Revit menjalankannya saat idle, dan kalau orang yang
    /// duduk di depannya sedang membuka dialog, jendela itu bisa panjang. Di
    /// dalam jendela itu server melihat "PC hidup, tidak memegang job apa pun,
    /// tapi ada job running" dan menyimpulkan job-nya terlantar — lalu menutupnya
    /// tepat sebelum Revit mulai mengerjakannya.
    /// </summary>
    public bool IsBusy => Volatile.Read(ref _busy) == 1 || !_pending.IsEmpty;

    public void Enqueue(JobDto job) => _pending.Enqueue(job);

    public string GetName() => "RevitTelegramBridge.CommandHandler";

    public void Execute(UIApplication app)
    {
        Interlocked.Exchange(ref _busy, 1);
        try
        {
            RevitVersion = app.Application.VersionNumber;

            var doc = app.ActiveUIDocument?.Document;
            LastKnownDocTitle = doc?.Title;

            // Antrean kosong adalah kejadian yang normal dan sering: worker
            // memanggil Raise() tiap siklus HANYA untuk menyegarkan dua nilai
            // di atas. Jangan pasang penampung dialog untuk itu — di luar job,
            // Revit tetap milik orang yang duduk di depannya.
            if (_pending.IsEmpty) return;

            using var dialogs = new DialogSuppressor(app);

            while (_pending.TryDequeue(out var job))
            {
                RunOne(job, doc, dialogs);
            }
        }
        catch (Exception ex)
        {
            Log.Error("Execute", ex);
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    private void RunOne(JobDto job, Document? doc, DialogSuppressor dialogs)
    {
        var report = new ReportRequest { Id = job.Id, DocTitle = doc?.Title };
        byte[]? fileBytes = null;
        string? fileName = null;
        var started = Stopwatch.StartNew();
        var dialogsBefore = dialogs.Dismissed.Count;

        try
        {
            if (doc is null)
            {
                report.Ok = false;
                report.Error = "Revit terbuka tapi belum ada model yang dibuka.";
            }
            else if (!DocMatches(doc, job.ExpectedDocTitle))
            {
                // Tanpa penjagaan ini, kamu bisa menerima PDF sheet LP-01 dari
                // project yang salah — dan tidak ada yang menandainya.
                report.Ok = false;
                report.Error = $"Model tidak cocok: {doc.Title}";
            }
            else if (!_commands.TryGetValue(job.Command, out var command))
            {
                report.Ok = false;
                report.Error = $"Command '{job.Command}' belum diimplementasi di add-in.";
            }
            else
            {
                var result = command.Run(doc, job.Payload);
                report.Ok = result.Ok;
                report.Text = result.Text;
                report.Error = result.Error;
                fileBytes = result.FileBytes;
                fileName = result.FileName;
            }
        }
        catch (Exception ex)
        {
            Log.Error($"job {job.Id} ({job.Command})", ex);
            report.Ok = false;
            report.Error = $"{ex.GetType().Name}: {ex.Message}";
        }

        started.Stop();
        report.ElapsedMs = (long)started.Elapsed.TotalMilliseconds;
        Log.Info($"job {job.Id} ({job.Command}) selesai dalam {started.Elapsed.TotalSeconds:N1}s, ok={report.Ok}");

        // Dialog yang muncul di tengah jalan ikut dilaporkan. Kalau hasilnya
        // nanti terlihat aneh, inilah penjelasannya — dan tanpa baris ini
        // penampung dialog justru menyembunyikan informasi yang kamu butuhkan.
        var dialogsHere = dialogs.Dismissed.Skip(dialogsBefore).ToList();
        if (dialogsHere.Count > 0)
        {
            report.Text = (report.Text ?? "").TrimEnd() +
                          $"\n\nDialog Revit yang ditutup otomatis: {string.Join(", ", dialogsHere)}";
        }

        // Report dikirim fire-and-forget: menunggu HTTP di main thread akan
        // membekukan UI Revit selama jaringan lambat.
        _ = Task.Run(async () =>
        {
            try { await BridgeClient.DeliverAsync(report, fileBytes, fileName, CancellationToken.None); }
            catch (Exception ex) { Log.Error("report", ex); }
        });
    }

    private static bool DocMatches(Document doc, string? expected) =>
        string.IsNullOrWhiteSpace(expected) ||
        string.Equals(doc.Title, expected, StringComparison.OrdinalIgnoreCase);
}
