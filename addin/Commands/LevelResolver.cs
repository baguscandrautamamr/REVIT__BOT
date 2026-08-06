using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Menentukan level sebuah elemen MEP.
///
/// Ini bagian yang paling sering salah dan paling sulit dilihat salahnya:
/// `element.LevelId` sering `InvalidElementId` untuk elemen MEP, sehingga
/// `/count` melaporkan 0 padahal ada puluhan — dan tidak ada yang tampak rusak.
/// Karena itu tiga sumber dicoba berurutan.
/// </summary>
public static class LevelResolver
{
    public static ElementId Resolve(Element e)
    {
        // 1. Properti langsung — benar untuk sebagian besar elemen arsitektur.
        if (e.LevelId != ElementId.InvalidElementId) return e.LevelId;

        // 2. Cable tray, conduit, duct, pipe.
        var start = e.get_Parameter(BuiltInParameter.RBS_START_LEVEL_PARAM);
        if (start is { StorageType: StorageType.ElementId })
        {
            var id = start.AsElementId();
            if (id != ElementId.InvalidElementId) return id;
        }

        // 3. Family instance (lampu, stop kontak, detektor).
        var family = e.get_Parameter(BuiltInParameter.FAMILY_LEVEL_PARAM);
        if (family is { StorageType: StorageType.ElementId })
        {
            var id = family.AsElementId();
            if (id != ElementId.InvalidElementId) return id;
        }

        // 4. Terakhir: host level untuk elemen yang menempel di sesuatu.
        var schedule = e.get_Parameter(BuiltInParameter.SCHEDULE_LEVEL_PARAM);
        if (schedule is { StorageType: StorageType.ElementId })
        {
            var id = schedule.AsElementId();
            if (id != ElementId.InvalidElementId) return id;
        }

        return ElementId.InvalidElementId;
    }

    /// <summary>Semua level di model, diurutkan dari bawah ke atas.</summary>
    public static List<Level> All(Document doc) =>
        new FilteredElementCollector(doc)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(l => l.Elevation)
            .ToList();

    /// <summary>Nama persis, tanpa tebakan apa pun.</summary>
    public static Level? FindExact(Document doc, string input) =>
        All(doc).FirstOrDefault(l => string.Equals(l.Name, input, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Cari level dari nama yang diketik user. Pencocokan longgar dengan sengaja:
    /// orang mengetik "L1" untuk level bernama "LANTAI 1".
    /// </summary>
    public static Level? FindByName(Document doc, string input) => Match(doc, input).Level;

    /// <summary>
    /// Sama seperti <see cref="FindByName"/>, tapi ikut melaporkan kandidat lain
    /// yang sama-sama cocok.
    ///
    /// Ini penting karena tebakan angka bisa mendua tanpa terlihat mendua:
    /// pada model dengan "Level 1" DAN "1st FLOOR", `/count L1` memilih salah
    /// satunya secara sewenang-wenang, lalu melaporkan angka lantai yang lain
    /// tanpa satu pun tanda bahwa itu bukan yang kamu maksud.
    /// </summary>
    public static (Level? Level, List<Level> Others) Match(Document doc, string input)
    {
        var levels = All(doc);
        var none = new List<Level>();

        var exact = levels
            .Where(l => string.Equals(l.Name, input, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (exact.Count > 0) return (exact[0], none);

        var contains = levels
            .Where(l => l.Name.Contains(input, StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (contains.Count > 0) return (contains[0], contains.Skip(1).ToList());

        // "L1" / "l 1" → cocokkan angkanya saja.
        var digits = Digits(input);
        if (digits.Length > 0)
        {
            var byDigits = levels.Where(l => Digits(l.Name) == digits).ToList();
            if (byDigits.Count > 0) return (byDigits[0], byDigits.Skip(1).ToList());
        }

        return (null, none);
    }

    private static string Digits(string s) => new(s.Where(char.IsDigit).ToArray());
}
