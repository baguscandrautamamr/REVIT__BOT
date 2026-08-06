using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Mencari sheet dan view dari nama yang diketik orang di Telegram.
///
/// Dipisah karena empat command mencarinya dengan aturan yang sama — dan
/// sebelum ini masing-masing menyalin aturannya sendiri, yang berarti
/// "ditemukan" bisa berarti hal berbeda tergantung command mana yang dipakai.
/// </summary>
internal static class ViewFinder
{
    public static List<ViewSheet> Sheets(Document doc) =>
        new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheet))
            .Cast<ViewSheet>()
            .Where(s => !s.IsTemplate)
            .ToList();

    /// <summary>
    /// View yang bisa diekspor: bukan template, dan bukan view yang tidak
    /// punya gambar (schedule, legend, browser).
    /// </summary>
    public static List<View> Printable(Document doc) =>
        new FilteredElementCollector(doc)
            .OfClass(typeof(View))
            .Cast<View>()
            .Where(v => !v.IsTemplate && v.CanBePrinted)
            .ToList();

    /// <summary>Nomor sheet dulu, baru namanya — nomor yang persis harus menang.</summary>
    public static ViewSheet? Sheet(Document doc, string wanted)
    {
        var sheets = Sheets(doc);
        return sheets.FirstOrDefault(s => Eq(s.SheetNumber, wanted))
            ?? sheets.FirstOrDefault(s => Eq(s.Name, wanted))
            ?? sheets.FirstOrDefault(s => Has(s.SheetNumber, wanted))
            ?? sheets.FirstOrDefault(s => Has(s.Name, wanted));
    }

    public static View? View(Document doc, string wanted)
    {
        var views = Printable(doc);
        return views.FirstOrDefault(v => Eq(v.Name, wanted))
            ?? views.FirstOrDefault(v => Has(v.Name, wanted));
    }

    /// <summary>
    /// Daftar nama untuk ditempel di pesan "tidak ditemukan".
    ///
    /// Menjawab "tidak ditemukan" tanpa menyebut apa yang ADA memaksa orang
    /// menebak — dan nama view di proyek nyata jarang bisa ditebak.
    /// </summary>
    public static string Suggest(IEnumerable<string> names, int max = 15)
    {
        var list = names.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
        var shown = list.Take(max).Select(n => "· " + n);
        var extra = list.Count > max ? $"\n…dan {list.Count - max} lainnya" : "";
        return string.Join("\n", shown) + extra;
    }

    private static bool Eq(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private static bool Has(string a, string b) => a.Contains(b, StringComparison.OrdinalIgnoreCase);
}
