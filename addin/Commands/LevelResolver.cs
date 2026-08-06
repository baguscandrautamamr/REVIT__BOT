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

    /// <summary>
    /// Cari level dari nama yang diketik user. Pencocokan longgar dengan sengaja:
    /// orang mengetik "L1" untuk level bernama "LANTAI 1".
    /// </summary>
    public static Level? FindByName(Document doc, string input)
    {
        var levels = new FilteredElementCollector(doc)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .ToList();

        var exact = levels.FirstOrDefault(l =>
            string.Equals(l.Name, input, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact;

        var contains = levels.FirstOrDefault(l =>
            l.Name.Contains(input, StringComparison.OrdinalIgnoreCase));
        if (contains is not null) return contains;

        // "L1" / "l 1" → cocokkan angkanya saja.
        var digits = new string(input.Where(char.IsDigit).ToArray());
        if (digits.Length > 0)
        {
            return levels.FirstOrDefault(l =>
                new string(l.Name.Where(char.IsDigit).ToArray()) == digits);
        }

        return null;
    }
}
