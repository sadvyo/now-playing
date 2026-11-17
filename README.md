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

## Use

- Run `NowPlaying-1.0.0-portable.exe`. Nothing gets installed, and it can take a few seconds to start because it unpacks itself first.
- Click the tray icon or press **Ctrl + Shift + Space** to open or close it. Right-click the tray icon for the menu.
- The pin button keeps the window on screen when you click elsewhere.
- Keys: Space = play/pause, Ctrl+←/→ = previous/next, 1/2 = switch tabs, Esc = hide.

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
npm start            # run in dev
npm run dist:win     # -> dist/NowPlaying-1.0.0-portable.exe
```

To build an installer instead, change `build.win.target` to `nsis` (building it on Linux needs Wine).

## Files

- `src/main.js`: tray, window, hotkey, picks which source to show
- `src/media/smtc.ps1` + `smtc.js`: Windows media sessions via PowerShell/WinRT (no native modules)
- `src/media/spotify.js`: Spotify OAuth (PKCE) and the player API
- `src/media/lyrics.js`: LRCLIB lyrics lookup and LRC parsing
- `src/claude/sessions.js`: Claude Code session reader
- `src/renderer/`: the pop-up UI
