// NowPlayingHelper — a small native companion for the Now Playing pop-up.
// Streams Windows media sessions (SMTC) as JSON lines on stdout, takes JSON
// commands on stdin, and reads/sets per-app volume. Same message format as the
// PowerShell fallback (src/media/smtc.ps1), so the app can use either.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace NowPlayingHelper;

internal static partial class Program
{
    [LibraryImport("ole32.dll")]
    private static partial int CoInitializeEx(IntPtr reserved, uint coInit);

    static readonly ConcurrentQueue<string> Commands = new();
    static readonly AutoResetEvent Wake = new(false);
    static volatile bool _dirty = true;
    static int _rateMs = 1000;
    static GlobalSystemMediaTransportControlsSessionManager? _mgr;
    static readonly Dictionary<string, string> ThumbKeySent = new();   // app -> key already sent
    static readonly Dictionary<string, int> ThumbTries = new();        // key -> attempts
    static readonly HashSet<string> Hooked = new();
    static string? _thumbErr;
    static volatile bool _rehook;
    static Stream _out = Stream.Null;

    static int Main(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "--rate" && int.TryParse(args[i + 1], out var r)) _rateMs = Math.Max(250, r);
        if (Array.IndexOf(args, "--selftest") >= 0) return SelfTest();

        CoInitializeEx(IntPtr.Zero, 0 /* COINIT_MULTITHREADED */);
        _out = Console.OpenStandardOutput();

        try
        {
            _mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask(), 10000);
        }
        catch (Exception e) { WriteRaw("{\"error\":" + JsonSerializer.Serialize(e.Message, HelperJson.Default.String) + "}"); return 2; }
        if (_mgr == null) { WriteRaw("{\"error\":\"media session manager unavailable\"}"); return 2; }

        _mgr.SessionsChanged += (_, _) => { _rehook = true; Poke(); };
        _mgr.CurrentSessionChanged += (_, _) => Poke();
        WriteRaw("{\"ready\":true,\"helper\":\"native\",\"version\":1}");

        var reader = new Thread(ReadCommands) { IsBackground = true, Name = "stdin" };
        reader.Start();

        var last = DateTime.MinValue;
        bool retryThumbs = false;
        while (true)
        {
            Wake.WaitOne(retryThumbs ? 900 : _rateMs);
            bool ranCmd = false;
            while (Commands.TryDequeue(out var line))
            {
                if (line == "\u0004") return 0; // stdin closed: parent app exited
                try { if (RunCommand(line)) ranCmd = true; } catch { /* ignore bad command */ }
            }
            var due = (DateTime.UtcNow - last).TotalMilliseconds >= _rateMs;
            if (ranCmd || due || _dirty || retryThumbs)
            {
                _dirty = false;
                last = DateTime.UtcNow;
                try { retryThumbs = Emit(); } catch (Exception e) { WriteRaw("{\"error\":" + JsonSerializer.Serialize(e.Message, HelperJson.Default.String) + "}"); }
            }
        }
    }

    static void Poke() { _dirty = true; Wake.Set(); }

    // Used by CI on a real Windows machine: exercises WinRT + Core Audio without media playing.
    static int SelfTest()
    {
        CoInitializeEx(IntPtr.Zero, 0);
        var mgr = Wait(GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask(), 10000);
        Console.WriteLine($"smtc manager: {(mgr != null ? "ok" : "FAILED")}, sessions: {mgr?.GetSessions().Count ?? -1}");
        int v = Audio.GetVolume("Spotify.exe", out bool m);
        Console.WriteLine($"audio: volume={v} muted={m} lastError={Audio.LastError ?? "none"}");
        bool set = Audio.SetVolume("Spotify.exe", 50);
        Console.WriteLine($"audio set (no session expected): {set} lastError={Audio.LastError ?? "none"}");
        Console.WriteLine($"names: {string.Join(",", Audio.ProcessNamesFor("308046B0AF4A39CB"))} {string.Join(",", Audio.ProcessNamesFor("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"))} {string.Join(",", Audio.ProcessNamesFor("C:\\Program Files\\foo\\Bar.exe"))}");
        return mgr != null ? 0 : 1;
    }

    static T? Wait<T>(Task<T> t, int ms) where T : class => t.Wait(ms) ? t.Result : null;
    static bool WaitBool(Task<bool> t, int ms) => t.Wait(ms) && t.Result;

    static void ReadCommands()
    {
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            Commands.Enqueue(line);
            Wake.Set();
        }
        Commands.Enqueue("\u0004");
        Wake.Set();
    }

    // Returns true when the command should trigger a fresh state message.
    static bool RunCommand(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        string action = root.TryGetProperty("action", out var a) ? a.GetString() ?? "" : "";
        string? app = root.TryGetProperty("app", out var ap) && ap.ValueKind == JsonValueKind.String ? ap.GetString() : null;

        if (action == "rate") { if (root.TryGetProperty("ms", out var ms)) _rateMs = Math.Max(250, ms.GetInt32()); return false; }
        if (action == "volume")
        {
            if (app == null || !root.TryGetProperty("level", out var lv)) return false;
            Audio.SetVolume(app, (int)Math.Round(lv.GetDouble()));
            return true;
        }
        if (_mgr == null) return false;
        foreach (var s in _mgr.GetSessions())
        {
            if (app != null && s.SourceAppUserModelId != app) continue;
            switch (action)
            {
                case "toggle": WaitBool(s.TryTogglePlayPauseAsync().AsTask(), 3000); break;
                case "play": WaitBool(s.TryPlayAsync().AsTask(), 3000); break;
                case "pause": WaitBool(s.TryPauseAsync().AsTask(), 3000); break;
                case "next": WaitBool(s.TrySkipNextAsync().AsTask(), 3000); break;
                case "previous": WaitBool(s.TrySkipPreviousAsync().AsTask(), 3000); break;
                case "seek":
                    if (root.TryGetProperty("positionMs", out var p))
                        WaitBool(s.TryChangePlaybackPositionAsync((long)(p.GetDouble() * 10000)).AsTask(), 3000);
                    break;
            }
            break;
        }
        return true;
    }

    static string? ReadThumb(GlobalSystemMediaTransportControlsSessionMediaProperties props)
    {
        if (props.Thumbnail == null) { _thumbErr = "app gave no picture"; return null; }
        try
        {
            var stream = Wait(props.Thumbnail.OpenReadAsync().AsTask(), 3000);
            if (stream == null) { _thumbErr = "open timed out"; return null; }
            using (stream)
            {
                ulong size = stream.Size;
                if (size == 0 || size > 8_000_000) { _thumbErr = $"picture size {size}"; return null; }
                using var reader = new DataReader(stream.GetInputStreamAt(0));
                var loaded = reader.LoadAsync((uint)size).AsTask();
                if (!loaded.Wait(3000)) { _thumbErr = "read timed out"; return null; }
                var bytes = new byte[loaded.Result];
                reader.ReadBytes(bytes);
                _thumbErr = null;
                var mime = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
                return "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
            }
        }
        catch (Exception e) { _thumbErr = "thumb: " + e.Message; return null; }
    }

    // Writes one state line. Returns true if a thumbnail should be retried soon.
    static bool Emit()
    {
        if (_mgr == null) return false;
        bool retry = false;
        string? current = null;
        try { current = _mgr.GetCurrentSession()?.SourceAppUserModelId; } catch { }

        using var buf = new MemoryStream();
        using (var w = new Utf8JsonWriter(buf))
        {
            w.WriteStartObject();
            w.WriteNumber("now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (current != null) w.WriteString("current", current); else w.WriteNull("current");
            if (_thumbErr != null) w.WriteString("thumbErr", _thumbErr); else w.WriteNull("thumbErr");
            if (Audio.LastError != null) w.WriteString("audioErr", Audio.LastError);
            w.WriteStartArray("sessions");
            Audio.ForgetProcesses();
            if (_rehook) { _rehook = false; Hooked.Clear(); } // players came or went: listen to the new ones
            foreach (var s in _mgr.GetSessions())
            {
                try
                {
                    var app = s.SourceAppUserModelId ?? "";
                    if (Hooked.Add(app))
                    {
                        // Instant updates instead of waiting for the next poll.
                        s.MediaPropertiesChanged += (_, _) => Poke();
                        s.PlaybackInfoChanged += (_, _) => Poke();
                        s.TimelinePropertiesChanged += (_, _) => Poke();
                    }
                    var props = Wait(s.TryGetMediaPropertiesAsync().AsTask(), 3000);
                    if (props == null) continue;
                    var pb = s.GetPlaybackInfo();
                    var tl = s.GetTimelineProperties();
                    var key = app + "|" + props.Title + "|" + props.Artist;
                    string? thumb = null;
                    ThumbKeySent.TryGetValue(app, out var sentKey);
                    if (sentKey != key)
                    {
                        ThumbTries.TryGetValue(key, out var tries);
                        if (tries < 8)
                        {
                            ThumbTries[key] = tries + 1;
                            thumb = ReadThumb(props);
                            if (thumb != null) ThumbKeySent[app] = key; else retry = true;
                        }
                    }
                    int vol = Audio.GetVolume(app, out bool muted);

                    w.WriteStartObject();
                    w.WriteString("app", app);
                    w.WriteString("title", props.Title ?? "");
                    w.WriteString("artist", props.Artist ?? "");
                    w.WriteString("album", props.AlbumTitle ?? "");
                    w.WriteString("albumArtist", props.AlbumArtist ?? "");
                    w.WriteString("status", pb.PlaybackStatus.ToString());
                    w.WriteBoolean("canNext", pb.Controls.IsNextEnabled);
                    w.WriteBoolean("canPrev", pb.Controls.IsPreviousEnabled);
                    w.WriteBoolean("canSeek", pb.Controls.IsPlaybackPositionEnabled);
                    w.WriteNumber("positionMs", (long)(tl.Position - tl.StartTime).TotalMilliseconds);
                    w.WriteNumber("durationMs", (long)(tl.EndTime - tl.StartTime).TotalMilliseconds);
                    long updated = 0;
                    try { updated = tl.LastUpdatedTime.ToUnixTimeMilliseconds(); } catch { }
                    w.WriteNumber("updatedAt", updated);
                    w.WriteString("thumbKey", key);
                    if (thumb != null) w.WriteString("thumb", thumb); else w.WriteNull("thumb");
                    if (vol >= 0) { w.WriteNumber("volume", vol); w.WriteBoolean("muted", muted); }
                    w.WriteEndObject();
                }
                catch { /* skip a session that vanished mid-read */ }
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        buf.WriteByte((byte)'\n');
        lock (_out) { _out.Write(buf.GetBuffer(), 0, (int)buf.Length); _out.Flush(); }
        return retry;
    }

    static void WriteRaw(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        lock (_out) { _out.Write(bytes, 0, bytes.Length); _out.Flush(); }
    }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(string))]
internal partial class HelperJson : System.Text.Json.Serialization.JsonSerializerContext { }
