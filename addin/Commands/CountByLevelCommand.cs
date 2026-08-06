using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /count &lt;level&gt; [kategori] [--detail] — rekap elemen MEP per lantai.
/// </summary>
public sealed class CountByLevelCommand : IBotCommand
{
    public string Name => "count";

    /// <summary>
    /// Kategori yang dihitung.
    ///
    /// PERIKSA INI TERHADAP MODELMU. Banyak family fire alarm sebenarnya
    /// ter-load sebagai Electrical Fixtures, bukan Fire Alarm Devices — pilih
    /// satu smoke detector di Revit dan lihat kategorinya di Properties.
    /// Kalau meleset, baris itu melaporkan 0 tanpa terlihat salah.
    /// </summary>
    private static readonly (string Label, BuiltInCategory Category)[] Categories =
    {
        ("Lampu",       BuiltInCategory.OST_LightingFixtures),
        ("Stop kontak", BuiltInCategory.OST_ElectricalFixtures),
        ("Cable tray",  BuiltInCategory.OST_CableTray),
        ("Komunikasi",  BuiltInCategory.OST_CommunicationDevices),
        ("Fire alarm",  BuiltInCategory.OST_FireAlarmDevices),
        ("Telepon",     BuiltInCategory.OST_TelephoneDevices),
        ("Data / LAN",  BuiltInCategory.OST_DataDevices),
        ("Sekuriti",    BuiltInCategory.OST_SecurityDevices),
    };

    public ExecResult Run(Document doc, JsonElement payload)
    {
        // `terms` = seluruh argumen apa adanya. Hanya di sini — di dalam Revit,
        // dengan daftar level model di tangan — batas antara nama level dan
        // filter kategori bisa ditentukan. Server tidak punya informasinya.
        var terms = payload.StrList("terms");
        if (terms.Count == 0)
        {
            var single = payload.Str("level");
            if (!string.IsNullOrWhiteSpace(single)) terms.Add(single);
            var legacy = payload.Str("category");
            if (!string.IsNullOrWhiteSpace(legacy)) terms.Add(legacy);
        }
        if (terms.Count == 0) return ExecResult.Fail("Level belum disebutkan.");

        var (level, others, filter) = SplitLevelAndFilter(doc, terms);
        if (level is null)
        {
            return ExecResult.Fail(
                $"Level \"{string.Join(" ", terms)}\" tidak ditemukan. " +
                "Ketik /levels untuk daftar nama persis.");
        }

        var detail = payload.Flag("detail");

        var sb = new StringBuilder();
        sb.AppendLine(level.Name);
        if (others.Count > 0)
        {
            // Tebakan yang mendua harus terlihat. Diam-diam memilih satu lalu
            // melaporkan angkanya sebagai fakta adalah cara tercepat membuat
            // orang percaya pada angka lantai yang salah.
            sb.AppendLine($"(cocok juga: {string.Join(", ", others.Select(l => l.Name))} — sebut nama lengkapnya kalau keliru)");
        }
        sb.AppendLine();

        var total = 0;
        var anyRow = false;
        var matchedCategory = false;

        foreach (var (label, category) in Categories)
        {
            if (!string.IsNullOrWhiteSpace(filter) &&
                !label.Contains(filter, StringComparison.OrdinalIgnoreCase) &&
                !category.ToString().Contains(filter, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            matchedCategory = true;

            // Elemen di dalam link TIDAK ikut terhitung oleh collector ini.
            // Itu perilaku Revit, bukan bug — sebutkan kalau angkanya dibandingkan
            // dengan schedule yang memasukkan link.
            var elements = new FilteredElementCollector(doc)
                .OfCategory(category)
                .WhereElementIsNotElementType()
                .Where(e => LevelResolver.Resolve(e) == level.Id)
                .ToList();

            if (elements.Count == 0 && !string.IsNullOrWhiteSpace(filter)) continue;

            anyRow = true;
            total += elements.Count;

            if (category == BuiltInCategory.OST_CableTray)
            {
                var metres = elements.Sum(LengthMetres);
                Layout.Row(sb, label, $"{elements.Count,5}   {metres,8:N1} m", 14);
            }
            else
            {
                Layout.Row(sb, label, $"{elements.Count,5}", 14);
            }

            if (detail && elements.Count > 0)
            {
                // Nama TIPE keluarga di proyek nyata panjang-panjang
                // ("Downlight LED 18W - Recessed - 200mm"). Dulu kolomnya
                // dipatok 24 tanpa dipotong, jadi setiap nama yang lebih panjang
                // mendorong angkanya keluar jalur dan kolomnya berhenti lurus
                // persis di baris yang paling banyak isinya.
                foreach (var group in elements
                             .GroupBy(TypeNameOf)
                             .OrderByDescending(g => g.Count()))
                {
                    Layout.Row(sb, "   " + group.Key, $"{group.Count(),4}", 28);
                }
            }
        }

        // Tiga sebab yang SANGAT berbeda dulu dijawab dengan satu kalimat yang
        // sama, "Tidak ada elemen MEP di lantai ini" — dan yang paling sering
        // terjadi bukan lantainya kosong, melainkan filternya salah ketik.
        if (!matchedCategory)
        {
            return ExecResult.Success(
                $"{level.Name}\n\nTidak ada kategori yang cocok dengan \"{filter}\".\n\n" +
                $"Kategori yang bisa dipakai:\n{string.Join("\n", Categories.Select(c => "· " + c.Label))}");
        }

        if (!anyRow || total == 0)
        {
            sb.AppendLine("Tidak ada elemen MEP di lantai ini.");
            sb.AppendLine();
            sb.Append(Diagnose(doc, level, filter));
            return ExecResult.Success(sb.ToString().TrimEnd());
        }

        sb.AppendLine();
        sb.Append($"Total {total} elemen");

        return ExecResult.Success(sb.ToString());
    }

    /// <summary>
    /// Pisahkan nama level dari filter kategori.
    ///
    /// Server memecah argumen pada spasi dan tidak bisa tahu di mana nama level
    /// berakhir — `/count GROUND FLOOR lighting` dulu terbaca sebagai level
    /// "GROUND" dengan kategori "FLOOR", lalu menjawab "tidak ada elemen MEP di
    /// lantai ini" untuk lantai yang justru paling penuh. Di sini daftar level
    /// model tersedia, jadi batasnya bisa ditentukan, bukan ditebak.
    ///
    /// Urutannya sengaja dari yang paling pasti ke yang paling longgar.
    /// </summary>
    private static (Level? Level, List<Level> Others, string? Filter) SplitLevelAndFilter(
        Document doc, List<string> terms)
    {
        // 1. Nama PERSIS, prefiks terpanjang dulu: "GROUND FLOOR" + "lighting"
        //    menang atas "GROUND" + "FLOOR lighting".
        for (var take = terms.Count; take >= 2; take--)
        {
            var candidate = string.Join(" ", terms.Take(take));
            var level = LevelResolver.FindExact(doc, candidate);
            if (level is not null) return (level, new List<Level>(), Rest(terms, take));
        }

        // 2. Nama sebagian, prefiks terpanjang dulu — tanpa tebakan angka.
        //    Tebakan angka dilarang di sini: pada "/count l1 lighting" ia akan
        //    menelan "lighting" ke dalam nama level dan mencocokkannya lewat
        //    angka "1", lalu filternya hilang tanpa jejak.
        for (var take = terms.Count; take >= 2; take--)
        {
            var candidate = string.Join(" ", terms.Take(take));
            var (level, others) = LevelResolver.Match(doc, candidate);
            if (level is not null &&
                level.Name.Contains(candidate, StringComparison.OrdinalIgnoreCase))
            {
                return (level, others, Rest(terms, take));
            }
        }

        // 3. Token pertama saja, dengan seluruh tebakan — termasuk angka.
        //    Ini yang membuat "/count L1" tetap bekerja.
        var (first, firstOthers) = LevelResolver.Match(doc, terms[0]);
        return (first, firstOthers, Rest(terms, 1));
    }

    private static string? Rest(List<string> terms, int take) =>
        terms.Count > take ? string.Join(" ", terms.Skip(take)) : null;

    /// <summary>
    /// Kenapa hasilnya nol.
    ///
    /// "Tidak ada elemen MEP di lantai ini" adalah jawaban yang buntu ketika
    /// kamu sedang menatap lantai yang penuh lampu di layar Revit. Dua angka di
    /// bawah ini memisahkan tiga kemungkinan yang selama ini tidak bisa
    /// dibedakan: salah lantai, elemennya memang tidak ada, atau levelnya tidak
    /// terbaca dari elemen (`LevelId` kosong — jebakan klasik elemen MEP).
    /// </summary>
    private static string Diagnose(Document doc, Level level, string? filter)
    {
        var inModel = 0;
        var withoutLevel = 0;
        var byLevel = new Dictionary<string, int>();

        foreach (var (label, category) in Categories)
        {
            if (!string.IsNullOrWhiteSpace(filter) &&
                !label.Contains(filter, StringComparison.OrdinalIgnoreCase) &&
                !category.ToString().Contains(filter, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var e in new FilteredElementCollector(doc)
                         .OfCategory(category)
                         .WhereElementIsNotElementType())
            {
                inModel++;
                var id = LevelResolver.Resolve(e);
                if (id == ElementId.InvalidElementId)
                {
                    withoutLevel++;
                    continue;
                }
                var name = doc.GetElement(id)?.Name ?? "(?)";
                byLevel[name] = byLevel.GetValueOrDefault(name) + 1;
            }
        }

        if (inModel == 0) return "Di seluruh model pun kategori ini tidak ada isinya.";

        var sb = new StringBuilder();
        sb.AppendLine($"Tapi di seluruh model ada {inModel} elemen kategori ini:");
        foreach (var row in byLevel.OrderByDescending(r => r.Value).Take(8))
        {
            Layout.Hanging(sb, row.Value.ToString(), row.Key, 8);
        }
        if (withoutLevel > 0)
        {
            Layout.Hanging(sb, withoutLevel.ToString(), "(levelnya tidak terbaca dari elemen)", 8);
        }
        sb.AppendLine();
        sb.Append($"Sebut salah satu nama di atas persis seperti tertulis, mis. /count \"{byLevel.Keys.FirstOrDefault() ?? level.Name}\"");
        return sb.ToString();
    }

    private static double LengthMetres(Element e)
    {
        var p = e.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH);
        // Panjang internal Revit dalam feet; 0.3048 m per feet.
        return p is null ? 0 : p.AsDouble() * 0.3048;
    }

    private static string TypeNameOf(Element e)
    {
        var typeId = e.GetTypeId();
        if (typeId == ElementId.InvalidElementId) return "(tanpa tipe)";
        return e.Document.GetElement(typeId)?.Name ?? "(tanpa tipe)";
    }
}
