# Now Playing — pop-up widget for Windows

A small always-on-top pop-up that lives in your system tray.

- **Playing tab**: whatever is playing right now, with artwork, a progress bar and play/pause/next/previous.
  - **Spotify account** (Web API): the track, album art and the device it's playing on.
  - **Any Windows player**: anything that appears in the Windows media flyout (Spotify desktop, YouTube or SoundCloud in Chrome/Edge/Firefox, VLC, Media Player, foobar2000…). No setup needed.
  - **Synced lyrics** for Spotify tracks. The current line is highlighted, and clicking a line jumps to it. Lyrics come from LRCLIB, because Spotify's lyrics aren't available through its public API. You can turn on lyrics for other players in Settings.
- **Spotify extras** (with your Spotify account connected):
  - **Play on another device**: move the music between your PC, phone or a speaker (the button right of the volume).
  - **Search and queue**: the magnifier (or **/**) searches Spotify; click a song to play it now, or queue it to play next.
  - **Add to playlist**: the button left of the heart puts the current song into one of your playlists; the one you used last is on top.
  - A heart that saves the song to your Liked Songs, and a subtle "Up next" row (next 3 songs in your queue).
- **Desktop lyrics**: the current lyric line in big karaoke-style text floating over your screen, with the next line under it. Clicks go straight through it. Turn it on in Settings → Desktop lyrics (or the tray menu, or a shortcut); **Move…** lets you drag it anywhere.
- **Wrong lyrics fix**: if the lyrics are for the wrong version of a song, hover the lyrics → **Wrong lyrics?** to pick another match, search for one, or turn lyrics off for that song. It's remembered per song.
- **Stats tab**: listening time today, this week, this month and in total, a chart by hour/day/month, and your top artists and songs. Kept only on your PC (`stats.json` in the app's data folder); you can switch it off or reset it in Settings.
- The current lyric line also scrolls in the mini player.
- **Tray icon**: shows a progress ring while Claude works and turns amber when Claude has a question.
- **Claude tab**: a progress bar for each chat Claude is working on, and an alert (Windows notification + amber card) when Claude asks you a question.
  - Chats: Settings → Claude → **Get Claude plugin** saves a plugin to your Downloads folder; upload it in Claude (Customize → Plugins → Upload a plugin) and restart Claude. Optionally paste the instruction into Claude's personal preferences. Claude reports progress through it; nothing is read from your account.
  - Claude Code sessions on this PC are picked up automatically, including questions and approval prompts.

## Install

Download **NowPlaying-Setup-x.y.z.exe** from the latest release and run it. It installs for your user only (no admin needed), adds a Start-menu and desktop shortcut, and starts the app. Updates install themselves.

A single-file **portable** `.exe` is also attached to each release. It starts slower because it unpacks itself each time, and it offers to switch to the installed version.

## Use

- Click the tray icon or press **Ctrl + Shift + Space**; right-click the tray icon for the menu.
- The pin keeps the window on screen; the picture-in-picture button switches to the mini player.
- Keys: Space = play/pause, Ctrl+←/→ = previous/next, 1/2/3 = tabs, / = search Spotify, M = mini player, Esc = close a panel or hide.
- Volume: the speaker button next to the controls, or scroll over it (or over the mini player's cover).
- Lyrics timing: hover the lyrics and use − / + (or the [ and ] keys) if they run early or late; it's remembered per song.
- Global shortcuts (Settings → Shortcuts): play/pause, next, previous, volume, mini-player click-through and desktop lyrics on/off, from anywhere in Windows.
- Mini player (Settings → Mini player): opacity, and click-through so clicks pass to what's underneath; hold Ctrl over it to use it.
- Appearance (Settings → Appearance): dark / light / match Windows, accent from the cover or a fixed color, cover-blur / plain / glass background, corner style, overall size, a big-cover layout instead of lyrics, lyrics text size, and which extras to show.

## Connect Spotify (one-time)

1. Go to https://developer.spotify.com/dashboard → **Create app** (any name, tick *Web API*).
2. Add the Redirect URI `http://127.0.0.1:8888/callback`. It has to be `127.0.0.1`; Spotify no longer accepts `localhost`.
3. Copy the **Client ID** into the app's Settings and press **Connect Spotify**. No client secret is needed (it uses PKCE).

Spotify's Development Mode requires the app owner to have **Premium**. Controlling playback through the Web API also needs Premium (that includes switching devices, playing a search result and adding to the queue). If the Spotify desktop app is open, the play/pause buttons go through Windows instead.

Coming from an older version: the first time you add a song to a playlist, the app asks you to reconnect Spotify once, because playlists need a permission the older versions didn't ask for.

## Limits

- Chat progress only appears when Claude calls the extension's tools. The instruction in your preferences makes this reliable, but Claude can still skip it now and then. It works in the Claude desktop app, not in claude.ai in a browser.
- Lyrics only work if LRCLIB has the song.
- Spotify only lets apps add songs to playlists you own or collaborate on, and search returns 10 songs at a time (Spotify's rules for Development Mode apps since February 2026).
- Listening stats count the song shown in the pop-up while it plays. Videos in browsers count too unless you switch that off in Settings → Listening stats.

## Build from source

```
npm install
npm run build:helper   # native helper (needs the .NET 8 SDK on Windows)
npm start              # run in dev
npm run dist:win       # -> dist/NowPlaying-Setup-x.y.z.exe and the portable .exe
```

Releases are built by GitHub Actions: bump `version` in package.json on `main` and the Release workflow publishes it.

## Files

- `src/main.js`: tray, window, hotkey, picks which source to show
- `helper/`: native helper (C#, Native AOT) for Windows media sessions, thumbnails and per-app volume
- `src/media/smtc.js`: talks to the helper, falls back to `smtc.ps1` (PowerShell) if the helper can't run
- `src/media/accent.js`: picks the accent color from the cover art
- `src/media/spotify.js`: Spotify OAuth (PKCE) and the player API
- `src/media/lyrics.js`: LRCLIB lyrics lookup, other matches for the lyrics picker, and LRC parsing
- `src/overlay.js` + `src/renderer/overlay.*`: the desktop lyrics window
- `src/stats.js`: listening stats (saved locally)
- `src/claude/sessions.js`: Claude Code session reader
- `src/renderer/`: the pop-up UI
