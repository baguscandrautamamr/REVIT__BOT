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
