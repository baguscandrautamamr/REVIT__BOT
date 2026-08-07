using System.Globalization;
using System.Text;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Satu baris rekap: satu kombinasi Family&amp;Type × Ruangan × Circuit.
///
/// Bentuknya meniru schedule Revit yang jadi acuan, supaya CSV ini bisa
/// dibandingkan baris per baris dengan schedule aslinya. Validasi itu bukan
/// kemewahan: kalau angkanya tidak cocok, seluruh laporan sesudahnya dibangun di
/// atas logika filter yang salah — dan angka salah yang masuk akal jauh lebih
/// berbahaya daripada error.
/// </summary>
internal sealed class CountRow
{
    public string Category { get; init; } = "";
    public string FamilyType { get; init; } = "";
    public string Level { get; init; } = "";
    public string? Room { get; init; }
    public int Count { get; init; }

    /// <summary>
    /// Total VA grup ini. NULL berarti tidak satu pun elemennya punya nilai —
    /// bukan nol. Lihat <see cref="ElectricalLoad.ApparentVa"/>.
    /// </summary>
    public double? TotalVa { get; init; }

    /// <summary>Berapa elemen di grup ini yang benar-benar punya nilai beban.</summary>
    public int WithLoad { get; init; }

    public string? Circuit { get; init; }

    /// <summary>Hanya untuk cable tray; null untuk kategori lain.</summary>
    public double? Metres { get; init; }
}

/// <summary>
/// Penyusun CSV untuk <c>/count --csv</c>.
///
/// KENAPA CSV, BUKAN PESAN CHAT: <see cref="Layout.Width"/> adalah 52 karakter —
/// diukur dari blok kode monospace Telegram di ponsel. Tabel enam kolom seperti
/// schedule Revit butuh sekitar 65 sebelum spasi antar kolom dihitung, dan nama
/// type di proyek nyata ("ACT_E_DOWNLIGHT 12W: EMG") justru yang paling panjang.
/// Memaksakannya jadi pesan chat berarti setiap baris menggeser layar ke samping,
/// dan kolom yang lain hilang dari pandangan.
/// </summary>
internal static class CountCsv
{
    /// <summary>
    /// Pemisah kolom dan format angka SENGAJA sama dengan
    /// <c>ExportScheduleCommand</c>: koma sebagai pemisah, titik sebagai desimal.
    ///
    /// Satu proyek sebaiknya punya satu kesepakatan CSV, bukan dua. Kalau Excel
    /// di PC-mu memakai locale Indonesia dan membuka berkas ini sebagai satu
    /// kolom, yang perlu diubah adalah KEDUA tempat sekaligus (jadi `;`), bukan
    /// yang ini saja — dua konvensi berbeda di satu bot lebih membingungkan
    /// daripada satu konvensi yang salah.
    /// </summary>
    private const char Delimiter = ',';

    private static readonly string[] Header =
    {
        "KATEGORI",
        "FAMILY & TYPE",
        "LEVEL",
        "RUANGAN",
        "COUNT",
        "APPARENT LOAD (VA)",
        "VA/UNIT",
        "CIRCUIT NUMBER",
        "PANJANG (m)",
    };

    public static byte[] Build(IReadOnlyList<CountRow> rows)
    {
        var sb = new StringBuilder();
        sb.Append(string.Join(Delimiter, Header)).Append("\r\n");

        foreach (var r in rows)
        {
            // VA/UNIT dibagi dengan jumlah elemen yang PUNYA nilai, bukan dengan
            // Count. Kalau 3 dari 5 elemen punya beban, membaginya dengan 5
            // menghasilkan angka per-unit yang tidak dimiliki elemen mana pun —
            // dan angka itu akan dikalikan orang lain untuk memperkirakan total.
            var perUnit = r.TotalVa is { } va && r.WithLoad > 0 ? va / r.WithLoad : (double?)null;

            var cells = new[]
            {
                Text(r.Category),
                Text(r.FamilyType),
                Text(r.Level),
                Text(r.Room),
                Int(r.Count),
                Num(r.TotalVa, 0),
                Num(perUnit, 0),
                Text(r.Circuit),
                Num(r.Metres, 1),
            };
            sb.Append(string.Join(Delimiter, cells)).Append("\r\n");
        }

        return WithUtf8Bom(Encoding.UTF8.GetBytes(sb.ToString()));
    }

    /// <summary>
    /// Sel teks, selalu dalam tanda kutip.
    ///
    /// Tanpa ini satu nama family yang mengandung koma menggeser SELURUH kolom
    /// di sisa baris itu — rusak yang tidak terlihat rusak, sebab berkasnya tetap
    /// terbuka dan angkanya tetap ada, hanya di kolom yang salah. Peringatan yang
    /// sama sudah tertulis di <c>ExportScheduleCommand.BuildOptions</c>; di sana
    /// Revit yang mengerjakannya, di sini harus kita sendiri.
    /// </summary>
    private static string Text(string? value)
    {
        var v = value ?? "";
        return '"' + v.Replace("\"", "\"\"") + '"';
    }

    private static string Int(int value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// Angka, atau sel KOSONG kalau nilainya null.
    ///
    /// Kosong dan nol tidak boleh tertukar: nol berarti "diukur, hasilnya nol",
    /// kosong berarti "tidak ada nilainya di model". Menulis nol untuk yang
    /// kedua membuat SUM di Excel terlihat lengkap padahal separuh datanya tidak
    /// pernah ada.
    /// </summary>
    private static string Num(double? value, int decimals) =>
        value is null ? "" : value.Value.ToString("F" + decimals, CultureInfo.InvariantCulture);

    /// <summary>
    /// Excel membaca CSV tanpa BOM sebagai ANSI, jadi nama berhuruf non-ASCII
    /// tampil rusak. <c>ExportScheduleCommand</c> punya helper serupa karena isi
    /// CSV-nya datang dari Revit; di sini kita yang menyusunnya sendiri.
    /// </summary>
    private static byte[] WithUtf8Bom(byte[] bytes)
    {
        var bom = Encoding.UTF8.GetPreamble();
        var result = new byte[bom.Length + bytes.Length];
        bom.CopyTo(result, 0);
        bytes.CopyTo(result, bom.Length);
        return result;
    }

    /* ── Pembacaan nilai per elemen ───────────────────────────────────────── */

    /// <summary>
    /// "Family: Type" — bentuk yang dipakai schedule Revit.
    ///
    /// <c>ElementType.FamilyName</c> bekerja untuk keduanya: <c>FamilySymbol</c>
    /// (lampu, stop kontak, detektor) memberi nama family loadable-nya, dan type
    /// sistem seperti cable tray memberi nama system family-nya. Jadi satu jalur,
    /// bukan dua cabang yang harus dijaga tetap sama.
    ///
    /// Dipisahkan dari <c>TypeNameOf</c> di CountByLevelCommand, dan itu
    /// disengaja: kolom nama di chat hanya 28 karakter, jadi tampilan chat tetap
    /// memakai nama type saja sementara CSV memakai nama lengkap.
    /// </summary>
    public static string FamilyTypeOf(Element e)
    {
        var typeId = e.GetTypeId();
        if (typeId == ElementId.InvalidElementId) return "(tanpa tipe)";

        if (e.Document.GetElement(typeId) is not ElementType type) return "(tanpa tipe)";

        var family = type.FamilyName;
        var name = type.Name;

        if (string.IsNullOrWhiteSpace(family)) return string.IsNullOrWhiteSpace(name) ? "(tanpa tipe)" : name;
        return string.IsNullOrWhiteSpace(name) ? family : $"{family}: {name}";
    }

    /// <summary>
    /// Nomor circuit seperti yang DITAMPILKAN Revit, termasuk format kurungnya
    /// ("(F)/8" untuk circuit yang belum ter-assign ke panel).
    ///
    /// Dibaca dari parameternya langsung, bukan disusun ulang dari
    /// <c>ElectricalSystem</c>: tujuan CSV ini justru dicocokkan dengan schedule
    /// Revit, dan parameter inilah yang dibaca schedule itu. Satu elemen dengan
    /// beberapa circuit (lampu emergency: normal + emergency) sudah digabungkan
    /// Revit di dalam nilainya.
    /// </summary>
    public static string? CircuitOf(Element e)
    {
        var p = e.get_Parameter(BuiltInParameter.RBS_ELEC_CIRCUIT_NUMBER);
        if (p is null) return null;

        var text = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString();
        return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
    }
}
