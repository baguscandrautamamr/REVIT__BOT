using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Menentukan ruangan sebuah elemen MEP.
///
/// Sama sifatnya dengan <see cref="LevelResolver"/>: tidak ada SATU sumber yang
/// benar untuk semua model, dan yang salah gagal dengan diam. Tiga jalur dicoba
/// berurutan, masing-masing dengan jebakannya sendiri:
///
///   1. <c>FamilyInstance.Room</c>  — hanya terisi kalau family-nya punya
///      *room calculation point* aktif. Untuk lampu di plafon sering null,
///      dan null-nya tidak berarti elemennya di luar ruangan.
///   2. <c>FamilyInstance.Space</c> — model MEP sering memakai Space alih-alih
///      Room; model tanpa analytical spaces tidak punya ini sama sekali.
///   3. <c>GetRoomAtPoint</c>       — selalu bisa dicoba asal elemennya punya
///      LocationPoint, tapi titik lampu di plafon bisa berada DI ATAS batas
///      atas room sehingga dianggap tidak masuk ruangan mana pun.
///
/// Yang dikembalikan bukan cuma namanya, tapi juga DARI MANA ia terbaca. Alasannya
/// sama seperti "Sumber angka" di <see cref="ElectricalLoad"/>: kolom ruangan yang
/// kosong untuk separuh model tidak boleh terlihat seperti "elemennya memang tidak
/// di ruangan mana pun". Dengan sumbernya ikut dilaporkan, jalannya sekali sudah
/// sekaligus menjadi diagnosanya — tidak perlu percobaan terpisah untuk mencari
/// tahu jalur mana yang hidup di model ini.
/// </summary>
internal static class RoomResolver
{
    public static (string? Name, string Source) Resolve(Element e)
    {
        if (e is FamilyInstance fi)
        {
            // Properti Revit di bawah ini melempar untuk sebagian family, bukan
            // mengembalikan null — dan yang dilempar bukan satu jenis exception
            // yang bisa dibedakan dari kerusakan sungguhan. Ditangkap di sini
            // supaya satu family bermasalah tidak menjatuhkan seluruh laporan.
            try
            {
                if (fi.Room is { } room)
                {
                    var name = NameOf(room);
                    if (name is not null) return (name, "FamilyInstance.Room");
                }
            }
            catch { /* family tanpa room calculation point */ }

            try
            {
                if (fi.Space is { } space)
                {
                    var name = NameOf(space);
                    if (name is not null) return (name, "FamilyInstance.Space");
                }
            }
            catch { /* model tanpa analytical spaces */ }
        }

        if ((e.Location as LocationPoint)?.Point is { } point)
        {
            try
            {
                var phase = PhaseOf(e);
                var room = phase is not null
                    ? e.Document.GetRoomAtPoint(point, phase)
                    : e.Document.GetRoomAtPoint(point);

                if (room is not null)
                {
                    var name = NameOf(room);
                    if (name is not null) return (name, "GetRoomAtPoint");
                }
            }
            catch { /* titik di luar semua room, atau fase tanpa room */ }
        }

        return (null, "");
    }

    /// <summary>
    /// Nama ruangan seperti yang ditulis Revit sendiri.
    ///
    /// Sengaja memakai <c>Element.Name</c>, bukan menyusun ulang dari
    /// <c>ROOM_NAME</c> + <c>ROOM_NUMBER</c>: Revit sudah menggabungkan keduanya
    /// ("MALE TOILET 008"), dan itu persis bentuk yang muncul di schedule yang
    /// akan dibandingkan dengan CSV ini. Menyusunnya sendiri berarti memilih
    /// format kedua yang harus dicocokkan manual setiap kali.
    /// </summary>
    private static string? NameOf(Element? spatial)
    {
        var name = spatial?.Name;
        return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
    }

    /// <summary>
    /// Fase pembuatan elemen — dipakai supaya pencarian lewat titik menanyakan
    /// room pada fase yang benar.
    ///
    /// Tanpa fase, <c>GetRoomAtPoint</c> memakai fase TERAKHIR model. Di proyek
    /// yang punya fase Existing + New itu bisa menjawab ruangan yang sudah
    /// dibongkar, atau tidak menjawab apa pun untuk elemen yang ruangannya hanya
    /// ada di fase lain.
    /// </summary>
    private static Phase? PhaseOf(Element e)
    {
        var p = e.get_Parameter(BuiltInParameter.PHASE_CREATED);
        if (p is null || p.StorageType != StorageType.ElementId) return null;

        var id = p.AsElementId();
        return id == ElementId.InvalidElementId ? null : e.Document.GetElement(id) as Phase;
    }
}
