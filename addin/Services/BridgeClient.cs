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

    /// <summary>Laporkan hasil satu job. File dikirim sebagai base64.</summary>
    public static async Task ReportAsync(ReportRequest report, CancellationToken ct)
    {
        var body = new StringContent(
            JsonSerializer.Serialize(report, Json), Encoding.UTF8, "application/json");

        using var res = await Http.PostAsync($"{BaseUrl}/api/machine/report", body, ct);
        if (!res.IsSuccessStatusCode)
        {
            Log.Warn($"report {(int)res.StatusCode} untuk job {report.Id}");
        }
    }
}

public sealed class HeartbeatInfo
{
    public string? ActiveDoc { get; set; }
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
}

public sealed class FileDto
{
    public string Name { get; set; } = "";
    public string Base64 { get; set; } = "";
}
