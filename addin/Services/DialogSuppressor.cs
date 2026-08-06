using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace RevitTelegramBridge.Services;

/// <summary>
/// Menutup otomatis dialog Revit yang muncul SELAMA sebuah job berjalan.
///
/// Kenapa perlu: PC Revit ini tidak ditunggui siapa pun. Satu dialog modal —
/// peringatan export, "elemen di luar area cetak", family yang minta konfirmasi
/// — akan menunggu klik yang tidak akan pernah datang. Main thread Revit
/// berhenti di situ, job tidak pernah melapor, dan dari sisi Telegram yang
/// terlihat cuma pesan "⏳" yang menggantung sampai penyapu membunuhnya 15
/// menit kemudian. Tidak ada satu pun petunjuk bahwa penyebabnya sebuah dialog.
///
/// Lingkupnya sengaja SEMPIT: hanya aktif di dalam <see cref="CommandHandler"/>
/// saat mengerjakan job, lalu langsung dilepas. Di luar itu Revit tetap milik
/// orang yang duduk di depannya — dialog yang mereka buka sendiri tidak boleh
/// hilang sendiri.
///
/// Setiap dialog yang ditutup DICATAT ke log, karena dialog yang hilang diam-
/// diam adalah informasi yang hilang: kalau hasil export terlihat aneh, baris
/// di bridge.log inilah yang menjelaskan kenapa.
/// </summary>
public sealed class DialogSuppressor : IDisposable
{
    private readonly UIApplication _app;
    private bool _disposed;

    /// <summary>Dialog yang sempat muncul dan ditutup, untuk ikut dilaporkan.</summary>
    public List<string> Dismissed { get; } = new();

    public DialogSuppressor(UIApplication app)
    {
        _app = app;
        _app.DialogBoxShowing += OnDialogBoxShowing;
    }

    private void OnDialogBoxShowing(object? sender, DialogBoxShowingEventArgs e)
    {
        var id = string.IsNullOrWhiteSpace(e.DialogId) ? "(tanpa id)" : e.DialogId;

        // Batasi jejaknya: satu dialog yang muncul berulang kali untuk tiap
        // elemen tidak boleh menghasilkan ribuan baris di laporan Telegram.
        if (Dismissed.Count < 10 && !Dismissed.Contains(id)) Dismissed.Add(id);

        Log.Warn($"dialog Revit ditutup otomatis: {id}");

        // 1 = tombol pertama / OK. Tidak ada pilihan yang lebih baik tanpa tahu
        // dialog apa yang muncul, dan menggantung selamanya jelas lebih buruk.
        try { e.OverrideResult(1); }
        catch (Exception ex) { Log.Error("OverrideResult", ex); }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _app.DialogBoxShowing -= OnDialogBoxShowing; }
        catch (Exception ex) { Log.Error("DialogSuppressor.Dispose", ex); }
    }
}
