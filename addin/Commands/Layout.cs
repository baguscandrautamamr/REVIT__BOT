using System.Text;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Penyusun baris untuk balasan yang akan dibaca di Telegram.
///
/// Ada karena setiap command menyusun tabelnya sendiri, dan semuanya memilih
/// jalan yang sama: potong teks yang tidak muat, tempel "…". Hasilnya nama yang
/// paling perlu dibaca justru yang hilang —
///   ME-F-EG-1101  GROUND &amp; FIRST FLOOR – GROUND …
/// — dan tidak ada satu pun cara bagi pembacanya untuk melihat sisanya.
///
/// Dua aturan di sini, dan keduanya berlaku untuk SEMUA command:
///
///   1. Tidak ada yang dipotong. Teks yang tidak muat DIBUNGKUS ke baris
///      berikutnya, bukan dibuang.
///   2. Tidak ada baris yang lebih lebar dari <see cref="Width"/>. Balasan
///      dibaca di layar ponsel; baris yang lebih lebar dari itu memaksa
///      menggeser layar ke samping untuk membaca satu kolom, dan kolom yang
///      lain hilang dari pandangan.
///
/// Balasan dari add-in dibungkus server sebagai blok kode monospace, jadi
/// perataan kolom di sini benar-benar rata di layar pembacanya.
/// </summary>
internal static class Layout
{
    /// <summary>
    /// Lebar baris paling aman.
    ///
    /// Diukur dari yang paling sempit: blok kode Telegram di ponsel muat
    /// sekitar 52–56 karakter sebelum mulai menggeser. Diambil yang lebih
    /// kecil — baris pendek di layar lebar cuma menyisakan ruang kosong,
    /// sedangkan baris panjang di layar sempit membuat isinya tidak terbaca.
    /// </summary>
    public const int Width = 52;

    /// <summary>
    /// Pecah teks pada batas KATA supaya tidak ada baris yang melewati lebar.
    ///
    /// Baris kosong dan pergantian baris yang sudah ada di dalam teks
    /// dipertahankan — beberapa command menyusun paragrafnya sendiri.
    /// </summary>
    public static List<string> Wrap(string? text, int width)
    {
        if (width < 8) width = 8;
        var lines = new List<string>();

        foreach (var paragraph in (text ?? "").Replace("\r", "").Split('\n'))
        {
            var line = new StringBuilder();

            foreach (var word in paragraph.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                var piece = word;

                // Satu kata yang sendirian sudah lebih lebar dari kolomnya tidak
                // bisa diselamatkan pembungkusan kata. Dipenggal — membiarkannya
                // utuh berarti satu baris yang menggeser seluruh layar.
                while (piece.Length > width)
                {
                    if (line.Length > 0) { lines.Add(line.ToString()); line.Clear(); }
                    lines.Add(piece[..width]);
                    piece = piece[width..];
                }

                if (line.Length == 0) line.Append(piece);
                else if (line.Length + 1 + piece.Length <= width) line.Append(' ').Append(piece);
                else { lines.Add(line.ToString()); line.Clear(); line.Append(piece); }
            }

            lines.Add(line.ToString());
        }

        return lines;
    }

    /// <summary>
    /// Satu catatan dua bagian: judul di barisnya sendiri, isinya menjorok di
    /// bawahnya.
    ///
    /// Dipakai untuk daftar yang isinya nama panjang — sheet, view, elemen.
    /// Judulnya (nomor sheet, mark) pendek dan bisa dipindai cepat; namanya
    /// dapat seluruh lebar baris, jadi tidak ada lagi alasan memotongnya.
    /// </summary>
    public static void Entry(StringBuilder sb, string head, string? body, string indent = "   ")
    {
        sb.AppendLine(head);
        if (string.IsNullOrWhiteSpace(body)) return;
        foreach (var line in Wrap(body, Width - indent.Length)) sb.AppendLine(indent + line);
    }

    /// <summary>
    /// Label di kiri, angka rata kanan di kolom tetap.
    ///
    /// Label yang lebih panjang dari kolomnya TIDAK dipotong dan tidak juga
    /// menggeser angkanya: ia mengambil barisnya sendiri, lalu angkanya menyusul
    /// di kolom yang sama seperti baris lain. Kolom angka tetap lurus, dan itu
    /// satu-satunya alasan tabel ini ada.
    /// </summary>
    public static void Row(StringBuilder sb, string label, string tail, int labelWidth)
    {
        if (label.Length <= labelWidth)
        {
            sb.AppendLine((label.PadRight(labelWidth) + tail).TrimEnd());
            return;
        }

        foreach (var line in Wrap(label, Width)) sb.AppendLine(line);
        sb.AppendLine((new string(' ', labelWidth) + tail).TrimEnd());
    }

    /// <summary>
    /// Angka di depan, kalimat panjang di belakangnya dengan indent menggantung.
    ///
    /// Untuk daftar yang isinya kalimat, bukan nama — deskripsi warning Revit
    /// bisa dua kalimat penuh, dan memotongnya membuang justru bagian yang
    /// menjelaskan apa yang salah.
    /// </summary>
    public static void Hanging(StringBuilder sb, string lead, string? text, int leadWidth)
    {
        var lines = Wrap(text, Width - leadWidth);
        var indent = new string(' ', leadWidth);

        sb.AppendLine((lead.PadLeft(Math.Max(1, leadWidth - 2)).PadRight(leadWidth) + lines[0]).TrimEnd());
        for (var i = 1; i < lines.Count; i++) sb.AppendLine((indent + lines[i]).TrimEnd());
    }

    /// <summary>
    /// Garis pemisah selebar isinya — penutup tabel, bukan hiasan.
    /// </summary>
    public static string Rule(int width = Width) => new('─', Math.Min(width, Width));
}
