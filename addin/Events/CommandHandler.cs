using System.Collections.Concurrent;
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
            new WarningsCommand(),
            new CountByLevelCommand(),
            new TrayCommand(),
            new FindByMarkCommand(),
            new ExportPdfCommand(),
            new ExportScheduleCommand(),
        }.ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>Dibaca worker: judul dokumen terakhir yang terlihat.</summary>
    public string? LastKnownDocTitle { get; private set; }

    public string? RevitVersion { get; private set; }

    /* ── Dilaporkan dari main thread ──────────────────────────────────────
       Dulu kedua nilai di atas HANYA terisi di dalam Execute — yaitu saat ada
       job masuk. Sebelum command pertama dijalankan, /status karena itu bilang
       "belum ada dokumen terbuka" dan "Revit: —" padahal modelnya jelas-jelas
       terbuka di layar. Yang salah bukan Revit, melainkan add-in yang memang
       belum pernah melihat.

       Tiga metode di bawah dipanggil App dari event Revit, yang seluruhnya
       berjalan di main thread — jadi aturan thread tetap utuh. Worker membaca
       propertinya tanpa lock: penulisan referensi string bersifat atomik di
       .NET, jadi yang terbaca selalu nilai lama atau nilai baru, tidak pernah
       separuh. */

    /// <summary>Main thread saja. Dokumen yang sedang dilihat user berubah.</summary>
    public void NoteActiveDocument(Document? doc) => LastKnownDocTitle = doc?.Title;

    /// <summary>
    /// Main thread saja. Dipanggil SEBELUM dokumen ditutup — saat ini judulnya
    /// masih bisa dibaca. Kalau yang ditutup bukan yang sedang dilaporkan,
    /// laporannya dibiarkan: masih ada dokumen lain yang terbuka.
    /// </summary>
    public void NoteDocumentClosing(Document? doc)
    {
        if (doc is null || doc.Title == LastKnownDocTitle) LastKnownDocTitle = null;
    }

    /// <summary>Main thread saja. Diketahui sejak OnStartup, tanpa perlu dokumen.</summary>
    public void NoteRevitVersion(string? version) => RevitVersion = version;

    public bool IsBusy => Volatile.Read(ref _busy) == 1;

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

            while (_pending.TryDequeue(out var job))
            {
                RunOne(job, doc);
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

    private void RunOne(JobDto job, Document? doc)
    {
        var report = new ReportRequest { Id = job.Id, DocTitle = doc?.Title };

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
                report.File = result.File;
            }
        }
        catch (Exception ex)
        {
            Log.Error($"job {job.Id} ({job.Command})", ex);
            report.Ok = false;
            report.Error = $"{ex.GetType().Name}: {ex.Message}";
        }

        // Report dikirim fire-and-forget: menunggu HTTP di main thread akan
        // membekukan UI Revit selama jaringan lambat.
        _ = Task.Run(async () =>
        {
            try { await BridgeClient.ReportAsync(report, CancellationToken.None); }
            catch (Exception ex) { Log.Error("report", ex); }
        });
    }

    private static bool DocMatches(Document doc, string? expected) =>
        string.IsNullOrWhiteSpace(expected) ||
        string.Equals(doc.Title, expected, StringComparison.OrdinalIgnoreCase);
}
