using System.Text.Json;
using Autodesk.Revit.DB;
using RevitTelegramBridge.Services;

namespace RevitTelegramBridge.Commands;

/// <summary>
/// Antarmuka seragam supaya menambah command = menambah satu berkas.
/// Semua implementasi dipanggil di main thread — aman memakai Revit API.
/// </summary>
public interface IBotCommand
{
    /// <summary>Harus sama dengan `name` di api/_lib/commands.ts.</summary>
    string Name { get; }

    ExecResult Run(Document doc, JsonElement payload);
}

public sealed class ExecResult
{
    public bool Ok { get; init; }
    public string? Text { get; init; }
    public string? Error { get; init; }

    /// <summary>
    /// Isi berkas hasil, MENTAH — bukan base64.
    ///
    /// Dulu di sini langsung disimpan sebagai base64 karena satu-satunya jalur
    /// pengiriman adalah menempelkannya ke body JSON /api/machine/report. Jalur
    /// itu ternyata tidak pernah bisa bekerja untuk berkas berukuran nyata:
    /// body request ke Serverless Function Vercel dibatasi 4,5 MB oleh
    /// platform, jadi setiap PDF sheet ditolak 413 sebelum handler-nya jalan.
    ///
    /// Sekarang BridgeClient yang memilih jalurnya — inline untuk yang kecil,
    /// unggah langsung ke Supabase Storage untuk yang besar — dan pilihan itu
    /// butuh byte aslinya, bukan yang sudah dikembungkan sepertiga.
    /// </summary>
    public byte[]? FileBytes { get; init; }

    public string? FileName { get; init; }

    public static ExecResult Success(string text) => new() { Ok = true, Text = text };

    public static ExecResult WithFile(string text, string name, byte[] bytes) => new()
    {
        Ok = true,
        Text = text,
        FileName = name,
        FileBytes = bytes,
    };

    public static ExecResult Fail(string error) => new() { Ok = false, Error = error };
}

internal static class PayloadExtensions
{
    public static string? Str(this JsonElement payload, string key) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty(key, out var v) &&
        v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    public static bool Flag(this JsonElement payload, string key) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty(key, out var v) &&
        v.ValueKind == JsonValueKind.True;

    public static List<string> StrList(this JsonElement payload, string key)
    {
        var list = new List<string>();
        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty(key, out var v) &&
            v.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in v.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    var s = item.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) list.Add(s);
                }
            }
        }
        return list;
    }
}
