using System.Text;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>Bagaimana sebuah kata berhasil (atau gagal) menunjuk satu sheet/view.</summary>
internal enum MatchKind
{
    /// <summary>Tidak ada yang cocok sama sekali.</summary>
    None,

    /// <summary>Nomor atau nama yang PERSIS. Tidak ada keraguan.</summary>
    Exact,

    /// <summary>Cocok sebagian, dan hanya satu-satunya. Tebakan, tapi tebakan tunggal.</summary>
    Loose,

    /// <summary>Cocok sebagian ke lebih dari satu. Tidak boleh ditebak.</summary>
    Ambiguous,
}

internal readonly struct ViewMatch
{
    public MatchKind Kind { get; init; }
    public View? View { get; init; }
    /// <summary>Nama yang cocok sebagian — hanya berarti saat Ambiguous.</summary>
    public List<string> Candidates { get; init; }
}

internal readonly struct SheetMatch
{
    public MatchKind Kind { get; init; }
    public ViewSheet? Sheet { get; init; }
    /// <summary>Berapa sheet yang cocok sebagian — hanya berarti saat Ambiguous.</summary>
    public int Candidates { get; init; }
}

/// <summary>
/// Hasil menerjemahkan daftar kata dari Telegram menjadi daftar sheet.
///
/// Dipisah dari command-nya karena /pdf dan /dwg harus menjawab dengan cara
/// yang sama persis: kata yang sama tidak boleh berarti sheet yang berbeda
/// tergantung command mana yang dipakai.
/// </summary>
internal sealed class SheetSelection
{
    public List<ViewSheet> Matched { get; } = new();

    /// <summary>Tidak cocok ke apa pun.</summary>
    public List<string> Missing { get; } = new();

    /// <summary>Cuma mirip, sementara kata lain di perintah yang sama sudah menyebut sheet dengan persis.</summary>
    public List<string> Ignored { get; } = new();

    /// <summary>Mirip ke beberapa sheet sekaligus — sengaja tidak ditebak.</summary>
    public List<string> Ambiguous { get; } = new();

    /// <summary>
    /// Baris tambahan untuk balasan ke chat. Setiap kata yang TIDAK jadi sheet
    /// harus muncul di sini; kata yang hilang diam-diam adalah persis cara
    /// /pdf mengirim gambar yang tidak diminta tanpa ada yang sadar.
    /// </summary>
    public string Notes()
    {
        var lines = new List<string>();
        if (Missing.Count > 0)
            lines.Add($"Dilewati (tidak ditemukan): {string.Join(", ", Missing)}");
        if (Ignored.Count > 0)
            lines.Add($"Diabaikan (cuma mirip, bukan nomor/nama sheet): {string.Join(", ", Ignored)}");
        if (Ambiguous.Count > 0)
            lines.Add($"Ambigu — sebut lebih lengkap: {string.Join(", ", Ambiguous)}");
        return lines.Count == 0 ? "" : "\n" + string.Join("\n", lines);
    }
}

/// <summary>
/// Mencari sheet dan view dari nama yang diketik orang di Telegram.
///
/// Dipisah karena empat command mencarinya dengan aturan yang sama — dan
/// sebelum ini masing-masing menyalin aturannya sendiri, yang berarti
/// "ditemukan" bisa berarti hal berbeda tergantung command mana yang dipakai.
/// </summary>
internal static class ViewFinder
{
    /// <summary>
    /// Panjang minimal sebuah kata supaya boleh dicocokkan SEBAGIAN.
    ///
    /// Angkanya lahir dari satu kejadian nyata:
    ///   /pdf ME-F-LP-1101 Export sheet ke PDF skala 1:1
    /// menghasilkan TIGA sheet, bukan satu. "ke" — dua huruf, kata sambung —
    /// dicocokkan sebagian ke nama sheet "…SO(CKE)T OUTLET LAYOUT…", dan
    /// "sheet" menyambar sheet "…& SHEET NAMING". Keduanya ikut terekspor
    /// tanpa satu pun tanda bahwa itu bukan yang diminta.
    ///
    /// Tiga huruf masih memuat nomor sheet terpendek yang masuk akal ("LP1"),
    /// tapi menutup kata sambung yang tidak pernah dimaksudkan sebagai pencarian.
    /// </summary>
    private const int MinLooseLength = 3;

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

    /// <summary>
    /// Terjemahkan daftar kata menjadi daftar sheet, sekali jalan.
    ///
    /// Aturan yang paling menentukan ada di akhir: kalau ADA kata yang menyebut
    /// sheet dengan persis, kata lain yang cuma MIRIP tidak dipakai sama sekali.
    ///
    /// Alasannya sederhana. Orang menulis kalimat:
    ///   /pdf ME-F-LP-1101 Export sheet ke PDF skala 1:1
    /// Server memecahnya pada spasi, jadi setiap kata di kalimat itu sampai ke
    /// sini sebagai calon nama sheet. Begitu satu di antaranya terbukti nomor
    /// sheet sungguhan, sisanya adalah kalimat — bukan pencarian. Menebaknya
    /// berarti mengirim gambar kerja yang tidak diminta, dan itu jenis
    /// kegagalan yang paling mahal di sistem ini.
    ///
    /// Pencarian bebas tetap utuh selama tidak dicampur: `/pdf lighting` tidak
    /// punya satu pun kecocokan persis, jadi kata itu tetap dicari sebagian.
    /// </summary>
    public static SheetSelection ResolveSheets(Document doc, IEnumerable<string> wanted)
    {
        var sheets = Sheets(doc);
        var terms = wanted.ToList();
        var found = terms.Select(term => (Term: term, Match: FindSheet(sheets, term))).ToList();
        var anyExact = found.Any(f => f.Match.Kind == MatchKind.Exact);

        var result = new SheetSelection();
        foreach (var (term, match) in found)
        {
            switch (match.Kind)
            {
                case MatchKind.Exact:
                    Add(result.Matched, match.Sheet!);
                    break;

                case MatchKind.Loose when anyExact:
                    // Menunjuk sheet yang memang sudah diminta dengan persis —
                    // tidak ada yang hilang, tidak perlu diributkan.
                    if (!result.Matched.Contains(match.Sheet!)) result.Ignored.Add(term);
                    break;

                case MatchKind.Loose:
                    Add(result.Matched, match.Sheet!);
                    break;

                case MatchKind.Ambiguous:
                    result.Ambiguous.Add($"{term} (cocok ke {match.Candidates} sheet)");
                    break;

                default:
                    result.Missing.Add(term);
                    break;
            }
        }
        return result;
    }

    /// <summary>Nomor sheet dulu, baru namanya — nomor yang persis harus menang.</summary>
    public static ViewSheet? Sheet(Document doc, string wanted)
    {
        var match = FindSheet(Sheets(doc), wanted);
        // Ambigu sengaja dijawab "tidak ada". Memilih yang pertama dari beberapa
        // yang sama-sama cocok berarti mengirim sheet yang salah dengan yakin,
        // dan penerimanya tidak punya cara tahu.
        return match.Kind is MatchKind.Exact or MatchKind.Loose ? match.Sheet : null;
    }

    private static SheetMatch FindSheet(List<ViewSheet> sheets, string wanted)
    {
        var exact = sheets.FirstOrDefault(s => Eq(s.SheetNumber, wanted))
                 ?? sheets.FirstOrDefault(s => Eq(s.Name, wanted));
        if (exact is not null) return new SheetMatch { Kind = MatchKind.Exact, Sheet = exact };

        if (wanted.Length < MinLooseLength) return new SheetMatch { Kind = MatchKind.None };

        // Nomor lebih dulu, dan kalau ada yang cocok di nomor, nama tidak ikut
        // dilihat: "LP-1101" yang cocok ke sebuah NOMOR sheet tidak boleh kalah
        // oleh sheet lain yang kebetulan menyebutnya di dalam judul.
        var byNumber = sheets.Where(s => Has(s.SheetNumber, wanted)).ToList();
        var pool = byNumber.Count > 0 ? byNumber : sheets.Where(s => Has(s.Name, wanted)).ToList();

        return pool.Count switch
        {
            0 => new SheetMatch { Kind = MatchKind.None },
            1 => new SheetMatch { Kind = MatchKind.Loose, Sheet = pool[0] },
            _ => new SheetMatch { Kind = MatchKind.Ambiguous, Candidates = pool.Count },
        };
    }

    /// <summary>View 3D yang bisa diekspor jadi gambar.</summary>
    public static List<View3D> Views3D(Document doc) =>
        new FilteredElementCollector(doc)
            .OfClass(typeof(View3D))
            .Cast<View3D>()
            .Where(v => !v.IsTemplate && v.CanBePrinted)
            .ToList();

    /// <summary>
    /// Cari SATU view untuk diekspor jadi gambar.
    ///
    /// Dua hal yang diperbaiki dari versi sebelumnya, dan keduanya bukan kosmetik:
    ///
    /// 1. View 3D dicari LEBIH DULU. Yang diminta orang dari /png hampir selalu
    ///    "coba lihat bentuknya", dan itu view 3D. Sebelumnya sheet dicari lebih
    ///    dulu SAMPAI SELESAI — termasuk kecocokan sebagiannya — jadi sheet yang
    ///    cuma mirip bisa mengalahkan view 3D yang namanya persis.
    ///
    /// 2. Cocok ke banyak view dibedakan dari tidak ada sama sekali. Sebelumnya
    ///    keduanya sama-sama mengembalikan null, dan pemanggilnya menjawab "tidak
    ///    ditemukan" untuk nama yang sebenarnya ditemukan — tiga kali. Orangnya
    ///    lalu mencari nama yang salah ketik, padahal yang perlu ia lakukan cuma
    ///    menyebutkan lebih lengkap.
    /// </summary>
    public static ViewMatch FindForImage(Document doc, string wanted, bool only3d)
    {
        var pool = new List<View>();
        var seen = new HashSet<ElementId>();

        void Add(IEnumerable<View> views)
        {
            foreach (var v in views) if (seen.Add(v.Id)) pool.Add(v);
        }

        Add(Views3D(doc));
        if (!only3d)
        {
            Add(Sheets(doc));
            Add(Printable(doc));
        }

        var exact = pool.FirstOrDefault(v => ExactFor(v, wanted));
        if (exact is not null) return new ViewMatch { Kind = MatchKind.Exact, View = exact };

        if (wanted.Length < MinLooseLength) return new ViewMatch { Kind = MatchKind.None };

        var loose = pool.Where(v => HasFor(v, wanted)).ToList();
        return loose.Count switch
        {
            0 => new ViewMatch { Kind = MatchKind.None },
            1 => new ViewMatch { Kind = MatchKind.Loose, View = loose[0] },
            _ => new ViewMatch
            {
                Kind = MatchKind.Ambiguous,
                Candidates = loose.Select(Label).OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList(),
            },
        };
    }

    /// <summary>Nama yang bisa diketik ulang orang untuk menunjuk view ini.</summary>
    public static string Label(View v) => v is ViewSheet s ? s.SheetNumber : v.Name;

    private static bool ExactFor(View v, string wanted) =>
        Eq(v.Name, wanted) || (v is ViewSheet s && Eq(s.SheetNumber, wanted));

    private static bool HasFor(View v, string wanted) =>
        Has(v.Name, wanted) || (v is ViewSheet s && Has(s.SheetNumber, wanted));

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

    /// <summary>
    /// Saran yang DIKELOMPOKKAN, dengan jatah untuk tiap kelompok.
    ///
    /// <see cref="Suggest"/> mengurutkan alfabetis lalu memotong. Itu tampak
    /// tidak berbahaya sampai satu kelompok memborong seluruh jatahnya:
    ///
    ///   /png 3D-ELEC → "Yang bisa dipakai:"
    ///     · **ACT STANDARDS**HATCH
    ///     · **ACT STANDARDS**LINE WEIGHTS 1-1
    ///     · **ACT STANDARDS**LINE WEIGHTS 1-10
    ///     …dua belas baris lagi yang sama
    ///
    /// Nama-nama itu diawali `*`, yang urutannya SEBELUM huruf — jadi lima belas
    /// slotnya habis oleh drafting view contoh ketebalan garis, dan sembilan view
    /// 3D yang justru dicari orangnya tidak pernah muncul sekali pun. Daftar yang
    /// gunanya menghapus tebakan malah memaksanya.
    ///
    /// Di sini tiap kelompok punya jatahnya sendiri dan jumlah aslinya selalu
    /// disebut, jadi tidak ada kelompok yang bisa menghapus kelompok lain.
    /// </summary>
    public static string SuggestGroups(int perGroup, params (string Label, IEnumerable<string> Names)[] groups)
    {
        var blocks = new List<string>();

        foreach (var (label, names) in groups)
        {
            var list = names.Where(n => !string.IsNullOrWhiteSpace(n))
                            .Distinct(StringComparer.OrdinalIgnoreCase)
                            .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
                            .ToList();
            if (list.Count == 0) continue;

            var sb = new StringBuilder();
            sb.AppendLine($"{label} ({list.Count}):");
            foreach (var name in list.Take(perGroup)) sb.AppendLine("· " + name);
            if (list.Count > perGroup) sb.AppendLine($"…dan {list.Count - perGroup} lagi");
            blocks.Add(sb.ToString().TrimEnd());
        }

        return string.Join("\n\n", blocks);
    }

    private static void Add(List<ViewSheet> into, ViewSheet sheet)
    {
        if (!into.Contains(sheet)) into.Add(sheet);
    }

    private static bool Eq(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    private static bool Has(string a, string b) => a.Contains(b, StringComparison.OrdinalIgnoreCase);
}
