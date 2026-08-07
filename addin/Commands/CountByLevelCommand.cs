using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// /count &lt;level&gt; [kategori] [--detail] [--csv] — rekap elemen MEP per lantai.
///
/// <c>--detail</c> memecah per nama TYPE di dalam balasan chat.
/// <c>--csv</c> mengirim berkas dengan kolom yang tidak mungkin muat di chat:
/// Family&amp;Type lengkap, ruangan, apparent load, dan nomor circuit — bentuk yang
/// sama dengan schedule Revit, supaya bisa dibandingkan baris per baris.
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
        var csv = payload.Flag("csv");

        // Hanya diisi saat --csv. Membacanya untuk setiap elemen tidak gratis:
        // ruangan dicari lewat sampai tiga jalur, salah satunya geometris.
        var csvRows = new List<CountRow>();
        var stats = new CsvStats();

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
                var groups = elements.GroupBy(TypeNameOf);

                // Cable tray diurutkan dan dilaporkan per METER, bukan per jumlah
                // batang. Jumlah batang tidak berarti apa-apa di lapangan — satu
                // segmen bisa 60 cm atau 3 m — dan baris kategorinya di atas sudah
                // menyebut meter, jadi rincian yang hanya menyebut jumlah membuat
                // dua angka yang tidak bisa dijumlahkan menjadi satu.
                var isTray = category == BuiltInCategory.OST_CableTray;
                var ordered = isTray
                    ? groups.OrderByDescending(g => g.Sum(LengthMetres))
                    : groups.OrderByDescending(g => g.Count());

                foreach (var group in ordered)
                {
                    var tail = isTray
                        ? $"{group.Count(),4}  {group.Sum(LengthMetres),8:N1} m"
                        : $"{group.Count(),4}";
                    Layout.Row(sb, "   " + group.Key, tail, 28);
                }
            }

            if (csv) AppendCsvRows(csvRows, label, category, level, elements, stats);
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

        if (!csv) return ExecResult.Success(sb.ToString());

        sb.AppendLine();
        sb.AppendLine();
        sb.AppendLine($"CSV: {csvRows.Count} baris (satu baris = Family&Type × ruangan × circuit).");

        // DARI MANA tiap kolom terbaca ikut disebut, dan itu bukan hiasan.
        // Kolom ruangan yang kosong untuk separuh model tidak boleh terlihat
        // seperti "elemennya memang tidak di ruangan mana pun" — dan hanya baris
        // ini yang bisa membedakan "jalur pembacaannya salah untuk model ini"
        // dari "datanya memang belum diisi".
        if (stats.RoomSources.Count > 0)
            sb.AppendLine($"Sumber ruangan: {string.Join(" + ", stats.RoomSources.OrderBy(s => s))}");
        if (stats.WithoutRoom > 0)
            sb.AppendLine($"{stats.WithoutRoom} elemen tanpa ruangan.");

        if (stats.LoadSources.Count > 0)
            sb.AppendLine($"Sumber beban: {string.Join(" + ", stats.LoadSources.OrderBy(s => s))}");
        if (stats.WithoutLoad > 0)
            sb.AppendLine($"{stats.WithoutLoad} elemen tanpa nilai beban — selnya DIKOSONGKAN, bukan diisi 0.");

        sb.Append("Bandingkan sekali dengan schedule Revit-mu. Kalau angkanya sama persis, logikanya benar.");

        var fileName = $"{Sanitize(doc.Title)}_{Sanitize(level.Name)}_count_{DateTime.Now:yyyy-MM-dd}.csv";
        return ExecResult.WithFile(sb.ToString().TrimEnd(), fileName, CountCsv.Build(csvRows));
    }

    /* ── Baris CSV ─────────────────────────────────────────────────────────── */

    /// <summary>
    /// Apa yang tidak terbaca, dan dari mana yang terbaca berasal.
    ///
    /// Dikumpulkan sepanjang penyusunan lalu dilaporkan sekali di chat. Tanpa ini
    /// CSV yang separuh kolomnya kosong terkirim tanpa sepatah kata pun — dan
    /// orang akan menyimpulkan modelnya yang kosong, bukan pembacaannya yang
    /// salah jalur.
    /// </summary>
    private sealed class CsvStats
    {
        public int WithoutRoom;
        public int WithoutLoad;
        public HashSet<string> RoomSources { get; } = new();
        public HashSet<string> LoadSources { get; } = new();
    }

    /// <summary>
    /// Kelompokkan satu kategori jadi baris CSV: Family&amp;Type × ruangan × circuit.
    ///
    /// Kunci pengelompokannya sengaja sama dengan schedule Revit yang jadi acuan.
    /// Menambah atau mengurangi satu bidang di kunci ini akan mengubah jumlah
    /// barisnya, dan perbandingan dengan schedule aslinya langsung tidak cocok
    /// lagi — padahal angka totalnya tetap benar. Yang paling sulit dilacak.
    /// </summary>
    private static void AppendCsvRows(
        List<CountRow> rows,
        string label,
        BuiltInCategory category,
        Level level,
        List<Element> elements,
        CsvStats stats)
    {
        var isTray = category == BuiltInCategory.OST_CableTray;

        var records = new List<(string FamilyType, string? Room, string? Circuit, double? Va, double Metres)>();

        foreach (var e in elements)
        {
            var (room, roomSource) = RoomResolver.Resolve(e);
            if (room is null) stats.WithoutRoom++;
            else stats.RoomSources.Add(roomSource);

            var (va, loadSource) = ElectricalLoad.ApparentVa(e);
            if (va is null) stats.WithoutLoad++;
            else stats.LoadSources.Add(loadSource);

            records.Add((CountCsv.FamilyTypeOf(e), room, CountCsv.CircuitOf(e), va, isTray ? LengthMetres(e) : 0));
        }

        foreach (var group in records
                     .GroupBy(r => (r.FamilyType, r.Room, r.Circuit))
                     .OrderBy(g => g.Key.FamilyType, StringComparer.OrdinalIgnoreCase)
                     .ThenBy(g => g.Key.Room ?? "", StringComparer.OrdinalIgnoreCase)
                     .ThenBy(g => g.Key.Circuit ?? "", StringComparer.OrdinalIgnoreCase))
        {
            var withLoad = group.Count(r => r.Va is not null);

            rows.Add(new CountRow
            {
                Category = label,
                FamilyType = group.Key.FamilyType,
                Level = level.Name,
                Room = group.Key.Room,
                Count = group.Count(),
                // Null, bukan nol, kalau TIDAK SATU PUN elemen di grup ini punya
                // nilai beban. Lihat CountCsv.Num untuk akibatnya di Excel.
                TotalVa = withLoad > 0 ? group.Sum(r => r.Va ?? 0) : null,
                WithLoad = withLoad,
                Circuit = group.Key.Circuit,
                Metres = isTray ? group.Sum(r => r.Metres) : null,
            });
        }
    }

    private static string Sanitize(string input)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(input.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return cleaned.Replace(' ', '_');
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
