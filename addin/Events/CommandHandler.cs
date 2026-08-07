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

    /// <summary>
    /// Judul SEMUA project yang sedang terbuka di sesi Revit ini.
    ///
    /// Satu Revit bisa membuka beberapa file sekaligus, dan sebelum ini bot
    /// hanya pernah tahu satu — yang kebetulan aktif. Akibatnya bukan cuma
    /// "tidak bisa memilih": job yang dibekukan ke project A akan DITOLAK kalau
    /// orang di depan PC kebetulan pindah tab ke project C sebelum Revit
    /// mengambilnya. Penjagaan yang benar, dengan alasan yang sama sekali tidak
    /// bisa ditebak dari sisi Telegram.
    ///
    /// Family dan link tidak ikut: keduanya ada di `Documents` tapi tak satu pun
    /// command di sini bisa dikerjakan terhadapnya, dan daftar pilihan yang
    /// separuhnya tidak bisa dipilih lebih buruk daripada daftar yang pendek.
    /// </summary>
    public IReadOnlyList<string> OpenDocTitles { get; private set; } = Array.Empty<string>();

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

            var active = app.ActiveUIDocument?.Document;
            LastKnownDocTitle = active?.Title;
            OpenDocTitles = ProjectDocs(app).Select(d => d.Title).ToList();

            // Antrean kosong adalah kejadian yang normal dan sering: worker
            // memanggil Raise() tiap siklus HANYA untuk menyegarkan dua nilai
            // di atas. Jangan pasang penampung dialog untuk itu — di luar job,
            // Revit tetap milik orang yang duduk di depannya.
            if (_pending.IsEmpty) return;

            using var dialogs = new DialogSuppressor(app);

            while (_pending.TryDequeue(out var job))
            {
                RunOne(job, app, active, dialogs);
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

    private void RunOne(JobDto job, UIApplication app, Document? active, DialogSuppressor dialogs)
    {
        var (doc, problem) = Target(app, active, job.ExpectedDocTitle);

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
                report.Error = problem;
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

    /// <summary>
    /// Project yang sedang terbuka — tanpa family dan tanpa link.
    ///
    /// `Application.Documents` memuat keduanya, dan tak satu pun command di sini
    /// bisa dikerjakan terhadapnya. Menawarkannya di daftar pilihan hanya
    /// membuat orang memilih sesuatu yang pasti gagal.
    /// </summary>
    private static IEnumerable<Document> ProjectDocs(UIApplication app)
    {
        foreach (Document d in app.Application.Documents)
        {
            if (d is null || d.IsFamilyDocument || d.IsLinked) continue;
            yield return d;
        }
    }

    /// <summary>
    /// Dokumen mana yang dikerjakan job ini, atau kenapa tidak ada.
    ///
    /// Inilah yang membuat satu Revit bisa melayani beberapa project sekaligus.
    /// Sebelumnya job SELALU dikerjakan terhadap dokumen yang aktif, dan yang
    /// tidak cocok ditolak — jadi orang yang duduk di depan PC menentukan
    /// project siapa pun yang mengirim perintah dari HP, tanpa tahu ia sedang
    /// menentukannya. Sekarang dokumennya dicari berdasarkan judul di antara
    /// SEMUA yang terbuka; yang di layar tidak lagi berpengaruh, dan tidak ada
    /// dokumen yang diaktifkan diam-diam.
    ///
    /// Project yang diminta tapi sudah ditutup TIDAK jatuh ke dokumen lain.
    /// Mengerjakannya di project terdekat berarti mengirim gambar kerja dari
    /// model yang salah — persis kegagalan yang paling mahal di sistem ini,
    /// karena hasilnya terlihat benar.
    /// </summary>
    private static (Document? Doc, string? Problem) Target(
        UIApplication app, Document? active, string? expected)
    {
        var open = ProjectDocs(app).ToList();

        if (string.IsNullOrWhiteSpace(expected))
        {
            return active is not null
                ? (active, null)
                : (null, "Revit terbuka tapi belum ada model yang dibuka.");
        }

        var match = open.FirstOrDefault(d => string.Equals(d.Title, expected, StringComparison.OrdinalIgnoreCase));
        if (match is not null) return (match, null);

        var list = open.Count == 0
            ? "(tidak ada project terbuka)"
            : string.Join("\n", open.Select(d => "· " + d.Title));

        return (null,
            $"Project \"{expected}\" tidak terbuka lagi di Revit.\n\nYang terbuka sekarang:\n{list}\n\n" +
            "Pilih ulang dengan /project.");
    }
}
