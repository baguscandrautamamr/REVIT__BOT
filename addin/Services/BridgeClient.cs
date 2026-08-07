using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RevitTelegramBridge.Services;

/// <summary>
/// Klien HTTP ke server Vercel. Semua komunikasi keluar dari PC — server tidak
/// pernah memanggil masuk, karena PC Revit tidak punya IP publik.
/// </summary>
public static class BridgeClient
{
    /// <summary>
    /// SATU instance untuk seumur proses.
    ///
    /// HttpClient yang dibuat per request membocorkan socket: tiap koneksi
    /// tertinggal di TIME_WAIT selama beberapa menit, dan pada polling 4 detik
    /// PC kehabisan port dalam hitungan jam. Gejalanya menyesatkan — bot
    /// "tiba-tiba mati" padahal Revit masih terbuka.
    /// </summary>
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(30),
    };

    /// <summary>
    /// Klien terpisah untuk mengunggah berkas, dengan timeout jauh lebih
    /// longgar.
    ///
    /// 30 detik cukup untuk JSON beberapa kilobyte, tapi tidak untuk PDF 20 MB
    /// lewat upload kantor: pada 1 MB/detik saja itu sudah 20 detik, dan
    /// jaringan yang lebih lambat membuat unggahannya DIBATALKAN di tengah
    /// jalan. Yang terjadi setelah itu tidak terlihat sebagai kesalahan sama
    /// sekali — TaskCanceledException dicatat ke log, job tetap `running`, dan
    /// di Telegram cuma ada "⏳" yang tidak pernah berubah.
    /// </summary>
    private static readonly HttpClient Upload = new()
    {
        Timeout = TimeSpan.FromMinutes(15),
    };

    /// <summary>
    /// Di bawah ini berkas ikut inline sebagai base64 di dalam laporan; di atas
    /// ini ia diunggah lebih dulu ke Supabase Storage.
    ///
    /// Batasnya ditentukan platform Vercel: body request ke Serverless Function
    /// maksimal 4,5 MB, keras, tidak bisa dinaikkan dari kode. Base64
    /// membengkakkan sepertiga, jadi 3 MB berkas ≈ 4 MB body — masih di bawah
    /// batas, dengan sisa untuk teks hasil dan selubung JSON-nya.
    /// </summary>
    private const int InlineLimitBytes = 3 * 1024 * 1024;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static string BaseUrl =>
        (Environment.GetEnvironmentVariable("REVIT_BRIDGE_URL")
         ?? "https://revit-bot.vercel.app").TrimEnd('/');

    static BridgeClient()
    {
        Http.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", TokenStore.Load() ?? "");
        Http.DefaultRequestHeaders.UserAgent.ParseAdd("RevitTelegramBridge/0.1");
    }

    /// <summary>Ambil satu job. Sekaligus heartbeat — dipanggil walau idle.</summary>
    public static async Task<ClaimResponse?> ClaimAsync(HeartbeatInfo info, CancellationToken ct)
    {
        var body = new StringContent(
            JsonSerializer.Serialize(info, Json), Encoding.UTF8, "application/json");

        using var res = await Http.PostAsync($"{BaseUrl}/api/machine/claim", body, ct);
        if (!res.IsSuccessStatusCode)
        {
            Log.Warn($"claim {(int)res.StatusCode}");
            return null;
        }

        var text = await res.Content.ReadAsStringAsync(ct);
        return JsonSerializer.Deserialize<ClaimResponse>(text, Json);
    }

    /// <summary>
    /// Antar hasil satu job: unggah berkasnya kalau ada, lalu laporkan.
    ///
    /// Urutannya penting. Berkas diunggah LEBIH DULU dan ke tempat yang bukan
    /// Vercel, lalu laporannya — yang selalu kecil — menyusul dan menyebut
    /// path-nya. Dengan begitu satu-satunya request yang harus berhasil demi
    /// menutup job adalah request kecil, dan job tidak bisa lagi tergantung
    /// selamanya hanya karena PDF-nya besar.
    ///
    /// Kegagalan unggah TIDAK membatalkan laporan. Sebaliknya: alasannya
    /// dititipkan di `fileError` supaya sampai ke chat. Berkas yang gagal tanpa
    /// sepatah kata pun adalah kegagalan yang paling mahal di sistem ini —
    /// orang menunggu belasan menit untuk sesuatu yang sudah lama selesai.
    /// </summary>
    public static async Task DeliverAsync(
        ReportRequest report, byte[]? fileBytes, string? fileName, CancellationToken ct)
    {
        if (fileBytes is { Length: > 0 } && !string.IsNullOrWhiteSpace(fileName))
        {
            try
            {
                report.File = await PrepareFileAsync(report.Id, fileName!, fileBytes, ct);
            }
            catch (Exception ex)
            {
                Log.Error($"unggah berkas job {report.Id}", ex);
                report.File = null;
                report.FileError = $"{ex.GetType().Name}: {ex.Message}";
            }
        }

        await ReportAsync(report, ct);
    }

    /// <summary>Pilih jalur pengiriman berkas, lalu siapkan rujukannya.</summary>
    private static async Task<FileDto> PrepareFileAsync(
        string jobId, string fileName, byte[] bytes, CancellationToken ct)
    {
        if (bytes.Length <= InlineLimitBytes)
        {
            Log.Info($"berkas {fileName} {bytes.Length / 1024} KB — inline");
            return new FileDto { Name = fileName, Base64 = Convert.ToBase64String(bytes) };
        }

        Log.Info($"berkas {fileName} {bytes.Length / 1024 / 1024} MB — lewat storage");

        var slot = await AskUploadSlotAsync(jobId, fileName, ct);

        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

        // `x-upsert` supaya menjalankan ulang command yang sama tidak tertolak
        // hanya karena sisa percobaan sebelumnya masih ada di bucket.
        using var request = new HttpRequestMessage(HttpMethod.Put, slot.UploadUrl) { Content = content };
        request.Headers.TryAddWithoutValidation("x-upsert", "true");

        using var res = await Upload.SendAsync(request, ct);
        if (!res.IsSuccessStatusCode)
        {
            var detail = await res.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException(
                $"unggah ke storage ditolak: HTTP {(int)res.StatusCode} {detail[..Math.Min(200, detail.Length)]}");
        }

        return new FileDto { Name = fileName, StoragePath = slot.Path };
    }

    private static async Task<UploadSlot> AskUploadSlotAsync(
        string jobId, string fileName, CancellationToken ct)
    {
        var body = new StringContent(
            JsonSerializer.Serialize(new { id = jobId, name = fileName }, Json),
            Encoding.UTF8, "application/json");

        using var res = await Http.PostAsync($"{BaseUrl}/api/machine/upload-url", body, ct);
        var text = await res.Content.ReadAsStringAsync(ct);

        if (!res.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"minta tempat unggah gagal: HTTP {(int)res.StatusCode} {text[..Math.Min(200, text.Length)]}");
        }

        var slot = JsonSerializer.Deserialize<UploadSlot>(text, Json);
        if (slot is null || string.IsNullOrWhiteSpace(slot.UploadUrl) || string.IsNullOrWhiteSpace(slot.Path))
        {
            throw new HttpRequestException("minta tempat unggah gagal: balasan tidak lengkap");
        }
        return slot;
    }

    /// <summary>
    /// Laporkan hasil satu job, dengan pengulangan.
    ///
    /// Laporan adalah SATU-SATUNYA cara sebuah job berpindah dari `running` ke
    /// selesai. Kalau ia hilang — wifi putus sedetik, fungsi Vercel dingin,
    /// Supabase sesaat lambat — barisnya tetap `running` sampai disapu 15 menit
    /// kemudian sebagai "stuck", padahal Revit sudah menyelesaikan kerjanya.
    /// Mencoba sekali lalu menyerah terlalu murah untuk taruhan sebesar itu.
    /// </summary>
    public static async Task ReportAsync(ReportRequest report, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(report, Json);

        for (var attempt = 1; attempt <= 4; attempt++)
        {
            try
            {
                using var body = new StringContent(payload, Encoding.UTF8, "application/json");
                using var res = await Http.PostAsync($"{BaseUrl}/api/machine/report", body, ct);
                if (res.IsSuccessStatusCode) return;

                var detail = await res.Content.ReadAsStringAsync(ct);
                Log.Warn($"report {(int)res.StatusCode} untuk job {report.Id} (percobaan {attempt}): " +
                         detail[..Math.Min(200, detail.Length)]);

                // 4xx tidak akan berubah kalau diulang dengan body yang sama —
                // kecuali 408/429, yang memang soal waktu.
                var status = (int)res.StatusCode;
                if (status is >= 400 and < 500 && status is not 408 and not 429) return;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                Log.Warn($"report job {report.Id} gagal (percobaan {attempt}): {ex.GetType().Name}: {ex.Message}");
            }

            if (attempt < 4)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(2 * attempt), ct); }
                catch (OperationCanceledException) { return; }
            }
        }

        Log.Error($"report job {report.Id}", new Exception("gagal setelah 4 percobaan — job akan disapu sebagai stuck"));
    }

    private sealed class UploadSlot
    {
        public string UploadUrl { get; set; } = "";
        public string Path { get; set; } = "";
    }
}

public sealed class HeartbeatInfo
{
    public string? ActiveDoc { get; set; }

    /// <summary>
    /// Judul SEMUA project yang terbuka di sesi Revit ini.
    ///
    /// Dikirim tiap heartbeat, bukan diminta saat dibutuhkan: `/project` harus
    /// bisa menampilkan tombol pilihannya seketika, dan daftar yang butuh satu
    /// siklus polling untuk muncul akan berhenti dipakai orang.
    /// </summary>
    public List<string> OpenDocs { get; set; } = new();
    public string? RevitVersion { get; set; }
    public string? AddinVersion { get; set; }

    /// <summary>
    /// Main thread masih mengerjakan job sebelumnya. Server tetap mencatat
    /// heartbeat-nya, tapi tidak memberi job baru.
    /// </summary>
    public bool Busy { get; set; }
}

public sealed class ClaimResponse
{
    public JobDto? Job { get; set; }
    public bool Paused { get; set; }
}

public sealed class JobDto
{
    public string Id { get; set; } = "";
    public string Command { get; set; } = "";
    public JsonElement Payload { get; set; }
    public string Lang { get; set; } = "id";
    public string? ExpectedDocTitle { get; set; }
}

public sealed class ReportRequest
{
    public string Id { get; set; } = "";
    public bool Ok { get; set; }
    public string? DocTitle { get; set; }
    public string? Text { get; set; }
    public string? Error { get; set; }
    public FileDto? File { get; set; }

    /// <summary>
    /// Kenapa berkasnya tidak ikut. Diisi saat unggah gagal — dan WAJIB
    /// diteruskan ke chat, bukan cuma dicatat di log.
    /// </summary>
    public string? FileError { get; set; }

    /// <summary>
    /// Lama eksekusi di dalam Revit, milidetik.
    ///
    /// Dilaporkan supaya "kenapa lama?" bisa dijawab dengan angka. Tanpa ini
    /// tidak ada cara membedakan export yang memang berat dari job yang
    /// tersangkut — keduanya sama-sama terlihat sebagai "⏳" yang lama.
    /// </summary>
    public long ElapsedMs { get; set; }
}

public sealed class FileDto
{
    public string Name { get; set; } = "";

    /// <summary>Isi berkas, untuk yang cukup kecil untuk ikut di body laporan.</summary>
    public string? Base64 { get; set; }

    /// <summary>Path di Supabase Storage, untuk yang tidak muat di body.</summary>
    public string? StoragePath { get; set; }
}
