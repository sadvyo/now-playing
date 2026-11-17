# Now Playing — pop-up widget for Windows

A small always-on-top pop-up that lives in your system tray.

- **Playing tab**: whatever is playing right now, with artwork, a progress bar and play/pause/next/previous.
  - **Spotify account** (Web API): the track, album art and the device it's playing on.
  - **Any Windows player**: anything that appears in the Windows media flyout (Spotify desktop, YouTube or SoundCloud in Chrome/Edge/Firefox, VLC, Media Player, foobar2000…). No setup needed.
  - **Synced lyrics** for Spotify tracks. The current line is highlighted, and clicking a line jumps to it. Lyrics come from LRCLIB, because Spotify's lyrics aren't available through its public API. You can turn on lyrics for other players in Settings.
- **Extras**: a heart button that saves the Spotify song to your Liked Songs, a subtle "Up next" row (next 3 songs in your Spotify queue), and the current lyric line scrolling in the mini player.
- **Tray icon**: shows a progress ring while Claude works and turns amber when Claude has a question.
- **Claude tab**: a progress bar for each chat Claude is working on, and an alert (Windows notification + amber card) when Claude asks you a question.
  - Chats: install the bundled Claude Desktop extension (Settings → Claude → Install), then paste the instruction into Claude's personal preferences. Claude reports progress through it; nothing is read from your account.
  - Claude Code sessions on this PC are picked up automatically, including questions and approval prompts.

## Install

Download **NowPlaying-Setup-x.y.z.exe** from the latest release and run it. It installs for your user only (no admin needed), adds a Start-menu and desktop shortcut, and starts the app. Updates install themselves.

A single-file **portable** `.exe` is also attached to each release. It starts slower because it unpacks itself each time, and it offers to switch to the installed version.

## Use

- Click the tray icon or press **Ctrl + Shift + Space**; right-click the tray icon for the menu.
- The pin keeps the window on screen; the picture-in-picture button switches to the mini player.
- Keys: Space = play/pause, Ctrl+←/→ = previous/next, 1/2 = tabs, M = mini player, Esc = hide.
- Volume: the speaker button next to the controls, or scroll over it (or over the mini player's cover).
- Lyrics timing: hover the lyrics and use − / + (or the [ and ] keys) if they run early or late; it's remembered per song.
- Global shortcuts (Settings → Shortcuts): play/pause, next, previous, volume, and mini-player click-through, from anywhere in Windows.
- Mini player (Settings → Mini player): opacity, and click-through so clicks pass to what's underneath; hold Ctrl over it to use it.
- Appearance (Settings → Appearance): dark / light / match Windows, accent from the cover or a fixed color, cover-blur / plain / glass background, corner style, overall size, a big-cover layout instead of lyrics, lyrics text size, and which extras to show.

## Connect Spotify (one-time)

1. Go to https://developer.spotify.com/dashboard → **Create app** (any name, tick *Web API*).
2. Add the Redirect URI `http://127.0.0.1:8888/callback`. It has to be `127.0.0.1`; Spotify no longer accepts `localhost`.
3. Copy the **Client ID** into the app's Settings and press **Connect Spotify**. No client secret is needed (it uses PKCE).

Spotify's Development Mode requires the app owner to have **Premium**. Controlling playback through the Web API also needs Premium. If the Spotify desktop app is open, the play/pause buttons go through Windows instead.

## Limits

- Chat progress only appears when Claude calls the extension's tools. The instruction in your preferences makes this reliable, but Claude can still skip it now and then. It works in the Claude desktop app, not in claude.ai in a browser.
- Lyrics only work if LRCLIB has the song.

## Build from source

```
npm install
npm run build:helper   # native helper (needs the .NET 8 SDK on Windows)
npm start              # run in dev
npm run dist:win       # -> dist/NowPlaying-Setup-x.y.z.exe and the portable .exe
```

Releases are built by GitHub Actions: bump `version` in package.json on `main` and the Release workflow publishes it.

To build an installer instead, change `build.win.target` to `nsis` (building it on Linux needs Wine).

## Files

- `src/main.js`: tray, window, hotkey, picks which source to show
- `helper/`: native helper (C#, Native AOT) for Windows media sessions, thumbnails and per-app volume
- `src/media/smtc.js`: talks to the helper, falls back to `smtc.ps1` (PowerShell) if the helper can't run
- `src/media/accent.js`: picks the accent color from the cover art
- `src/media/spotify.js`: Spotify OAuth (PKCE) and the player API
- `src/media/lyrics.js`: LRCLIB lyrics lookup and LRC parsing
- `src/claude/sessions.js`: Claude Code session reader
- `src/renderer/`: the pop-up UI
