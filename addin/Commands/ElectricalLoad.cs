using System.Text.RegularExpressions;
using Autodesk.Revit.DB;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Pembacaan apparent load satu elemen, dalam VA.
///
/// DIPISAH KE SINI karena sekarang dipakai dua command — <c>/load</c> dan
/// <c>/count --csv</c> — dan menyalin logikanya untuk yang kedua adalah cara
/// termudah melahirkan DUA angka VA berbeda untuk elemen yang sama. Yang salah
/// di antara keduanya tidak akan terlihat salah: keduanya angka yang wajar,
/// dalam satuan yang benar, dari model yang sama.
///
/// Tiga hal di bawah ini sudah dibayar mahal sekali; jangan disederhanakan
/// tanpa membaca alasannya.
/// </summary>
internal static class ElectricalLoad
{
    /// <summary>Parameter ringkasan connector di Revit: "220 V/1-31 VA".</summary>
    internal const string ElectricalDataParam = "Electrical Data";

    /// <summary>Angka tepat sebelum satuan VA, berapa pun connector-nya.</summary>
    private static readonly Regex VaPattern = new(@"([\d.,]+)\s*VA\b", RegexOptions.IgnoreCase);

    /// <summary>
    /// Apparent load satu elemen dalam VA, beserta dari mana angkanya diambil.
    ///
    /// <c>Electrical Data</c> DIDAHULUKAN, dan itu berdasarkan model yang
    /// sebenarnya: <c>RBS_ELEC_APPARENT_LOAD</c> di instance kosong untuk
    /// seluruh 605 elemen di proyek ini — beban lampu dan stop kontaknya
    /// didefinisikan di connector keluarga, dan yang menampilkannya adalah
    /// string ringkasan itu. Membaca parameter yang kosong lalu melaporkan
    /// "Total 0 VA" bukan cuma tidak menolong; ia angka yang terlihat seperti
    /// hasil pengukuran.
    ///
    /// Mengembalikan null — BUKAN nol — kalau tidak ada satu pun sumber yang
    /// terisi. Bedanya penting: nol berarti "diukur, hasilnya nol", null berarti
    /// "tidak diukur", dan menjumlahkan keduanya sebagai nol menyembunyikan
    /// separuh model di balik angka yang meyakinkan.
    /// </summary>
    public static (double? Va, string Source) ApparentVa(Element e)
    {
        var doc = e.Document;
        var type = doc.GetElement(e.GetTypeId());

        var text = FromElectricalData(e) ?? FromElectricalData(type);
        if (text is not null) return (text, ElectricalDataParam);

        var param = FromApparentParam(e) ?? FromApparentParam(type);
        if (param is not null) return (param, "Apparent Load");

        return (null, "");
    }

    /// <summary>Jumlahkan SEMUA "… VA" di string — satu family bisa punya beberapa connector.</summary>
    private static double? FromElectricalData(Element? e)
    {
        var p = e?.LookupParameter(ElectricalDataParam);
        if (p is null) return null;

        var text = p.StorageType == StorageType.String ? p.AsString() : p.AsValueString();
        if (string.IsNullOrWhiteSpace(text)) return null;

        double total = 0;
        var found = false;
        foreach (Match m in VaPattern.Matches(text))
        {
            if (TryNumber(m.Groups[1].Value, out var va)) { total += va; found = true; }
        }
        return found ? total : null;
    }

    private static double? FromApparentParam(Element? e)
    {
        var p = e?.get_Parameter(BuiltInParameter.RBS_ELEC_APPARENT_LOAD);
        if (p is null || !p.HasValue || p.StorageType != StorageType.Double) return null;

        // Satuan internal Revit untuk daya BUKAN VA — ia diturunkan dari kaki,
        // jadi angkanya meleset 10,7639 kali kalau dipakai apa adanya. Kesalahan
        // yang sama pernah membuat /panel melaporkan 1.421.719 VA untuk panel
        // yang schedule-nya menulis 132.082 VA.
        var va = UnitUtils.ConvertFromInternalUnits(p.AsDouble(), UnitTypeId.VoltAmperes);
        return va > 0 ? va : null;
    }

    /// <summary>
    /// "1.200" atau "1,200" → 1200; "31" → 31; "1,5" atau "1.5" → 1,5.
    ///
    /// Revit menulis angkanya memakai pemisah ribuan sesuai bahasa Windows-nya,
    /// dan di Indonesia titik berarti ribuan — kebalikan dari Inggris. Menebak
    /// salah pada "1.200" menghasilkan 1,2 VA untuk beban 1.200 VA: seperseribu,
    /// dan tetap terlihat seperti angka yang wajar.
    /// </summary>
    private static bool TryNumber(string raw, out double value)
    {
        var s = raw.Trim();

        // Pola ribuan: 1-3 digit, lalu kelompok tepat 3 digit berulang.
        if (Regex.IsMatch(s, @"^\d{1,3}([.,]\d{3})+$"))
        {
            return double.TryParse(s.Replace(".", "").Replace(",", ""),
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out value);
        }

        // Satu pemisah dengan digit selain kelipatan tiga = desimal.
        s = s.Replace(',', '.');
        return double.TryParse(s, System.Globalization.NumberStyles.Any,
            System.Globalization.CultureInfo.InvariantCulture, out value);
    }
}
