// Per-app volume through Windows Core Audio (IAudioSessionManager2), using
// source-generated COM interop so it works with Native AOT.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;

namespace NowPlayingHelper;

[GeneratedComInterface, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
internal partial interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice(IntPtr id, out IntPtr device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[GeneratedComInterface, Guid("D666063F-1587-4E43-81F1-B948E807363F")]
internal partial interface IMMDevice
{
    [PreserveSig] int Activate(in Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
}

[GeneratedComInterface, Guid("BFA971F1-4D5E-40BB-935E-967039BFBEE4")]
internal partial interface IAudioSessionManager
{
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
}

[GeneratedComInterface, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
internal partial interface IAudioSessionManager2 : IAudioSessionManager
{
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    [PreserveSig] int RegisterSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
    [PreserveSig] int RegisterDuckNotification(IntPtr sessionId, IntPtr notification);
    [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
}

[GeneratedComInterface, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
internal partial interface IAudioSessionEnumerator
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl session);
}

[GeneratedComInterface, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
internal partial interface IAudioSessionControl
{
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr name, in Guid eventContext);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr path, in Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(in Guid grouping, in Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
}

[GeneratedComInterface, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
internal partial interface IAudioSessionControl2 : IAudioSessionControl
{
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(int optOut);
}

[GeneratedComInterface, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
internal partial interface ISimpleAudioVolume
{
    [PreserveSig] int SetMasterVolume(float level, in Guid eventContext);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(int mute, in Guid eventContext);
    [PreserveSig] int GetMute(out int mute);
}

internal static partial class Audio
{
    static readonly Guid CLSID_MMDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IMMDeviceEnumerator = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    static readonly Guid IID_IAudioSessionManager2 = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    const uint CLSCTX_ALL = 0x17;

    [LibraryImport("ole32.dll")]
    private static partial int CoCreateInstance(in Guid clsid, IntPtr outer, uint ctx, in Guid iid, out IntPtr ppv);

    static readonly StrategyBasedComWrappers Cw = new();
    static IMMDeviceEnumerator? _enum;
    static readonly Dictionary<uint, string> PidNames = new();
    public static string? LastError;

    static IMMDeviceEnumerator? Enumerator()
    {
        if (_enum != null) return _enum;
        int hr = CoCreateInstance(CLSID_MMDeviceEnumerator, IntPtr.Zero, CLSCTX_ALL, IID_IMMDeviceEnumerator, out var p);
        if (hr != 0 || p == IntPtr.Zero) { LastError = $"CoCreateInstance 0x{hr:X8}"; return null; }
        _enum = (IMMDeviceEnumerator)Cw.GetOrCreateObjectForComInstance(p, CreateObjectFlags.None);
        Marshal.Release(p);
        return _enum;
    }

    // Which process names belong to a media session id (AUMID).
    public static string[] ProcessNamesFor(string aumid)
    {
        var a = (aumid ?? "").ToLowerInvariant();
        if (a.Contains("spotify")) return new[] { "spotify" };
        if (a.Contains("msedge") || a.Contains("microsoftedge")) return new[] { "msedge" };
        if (a.Contains("chrome")) return new[] { "chrome" };
        if (a.Contains("firefox") || a == "308046b0af4a39cb") return new[] { "firefox" };
        if (a.Contains("opera")) return new[] { "opera" };
        if (a.Contains("brave")) return new[] { "brave" };
        if (a.Contains("vivaldi")) return new[] { "vivaldi" };
        if (a.Contains("vlc")) return new[] { "vlc" };
        if (a.Contains("zunevideo")) return new[] { "video.ui" };
        if (a.Contains("zunemusic") || a.Contains("media.player")) return new[] { "microsoft.media.player", "music.ui" };
        if (a.Contains("discord")) return new[] { "discord" };
        var tail = a.Contains('!') ? a[(a.LastIndexOf('!') + 1)..] : a;
        tail = tail.Replace('/', '\\');
        if (tail.Contains('\\')) tail = tail[(tail.LastIndexOf('\\') + 1)..];
        if (tail.EndsWith(".exe")) tail = tail[..^4];
        return new[] { tail };
    }

    static string NameOf(uint pid)
    {
        if (PidNames.TryGetValue(pid, out var n)) return n;
        try { n = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { n = ""; }
        PidNames[pid] = n;
        return n;
    }

    // Visit every audio session on the default speakers whose process matches.
    static int ForEach(string[] names, Func<ISimpleAudioVolume, bool> visit)
    {
        var en = Enumerator();
        if (en == null) return 0;
        if (en.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out var dev) != 0 || dev == null) { LastError = "no speakers"; return 0; }
        if (dev.Activate(IID_IAudioSessionManager2, (int)CLSCTX_ALL, IntPtr.Zero, out var mp) != 0 || mp == IntPtr.Zero) { LastError = "activate failed"; return 0; }
        var mgr = (IAudioSessionManager2)Cw.GetOrCreateObjectForComInstance(mp, CreateObjectFlags.None);
        Marshal.Release(mp);
        if (mgr.GetSessionEnumerator(out var sessions) != 0 || sessions == null) return 0;
        sessions.GetCount(out int count);
        int hits = 0;
        for (int i = 0; i < count; i++)
        {
            if (sessions.GetSession(i, out var ctl) != 0 || ctl == null) continue;
            if (ctl is not IAudioSessionControl2 c2) continue;
            if (c2.GetProcessId(out uint pid) != 0 || pid == 0) continue;
            var pname = NameOf(pid);
            bool match = false;
            foreach (var n in names) if (pname == n) { match = true; break; }
            if (!match) continue;
            if (ctl is not ISimpleAudioVolume vol) continue;
            hits++;
            if (!visit(vol)) break;
        }
        return hits;
    }

    // Returns 0..100, or -1 when the app has no audio session right now.
    public static int GetVolume(string aumid, out bool muted)
    {
        float level = -1; int m = 0;
        try
        {
            ForEach(ProcessNamesFor(aumid), v => { v.GetMasterVolume(out level); v.GetMute(out m); return false; });
        }
        catch (Exception e) { LastError = e.Message; }
        muted = m != 0;
        return level < 0 ? -1 : (int)Math.Round(level * 100);
    }

    public static bool SetVolume(string aumid, int percent)
    {
        float lv = Math.Clamp(percent, 0, 100) / 100f;
        try
        {
            var ctx = Guid.Empty;
            return ForEach(ProcessNamesFor(aumid), v => { v.SetMasterVolume(lv, ctx); if (lv > 0) v.SetMute(0, ctx); return true; }) > 0;
        }
        catch (Exception e) { LastError = e.Message; return false; }
    }

    public static void ForgetProcesses() => PidNames.Clear();
}
