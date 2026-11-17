# Streams Windows "System Media Transport Controls" sessions as JSON lines.
# Any app that shows up in the Windows volume / media flyout appears here:
# Spotify, browsers (YouTube, SoundCloud...), VLC, Movies & TV, foobar2000, etc.
# Commands are picked up from a small JSON file that the Electron app writes.
param([string]$CmdFile, [string]$ThumbDir, [int]$RateMs = 1000)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# Windows PowerShell 5.1 sometimes serialises arrays as {"value":[...],"Count":n}
try { Remove-TypeData System.Array -ErrorAction SilentlyContinue } catch {}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

$asTaskProg = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperationWithProgress`2'
})[0]

function AwaitProg($op, [Type]$result, [Type]$progress) {
  $t = $asTaskProg.MakeGenericMethod($result, $progress).Invoke($null, @($op))
  [void]$t.Wait(5000)
  if ($t.IsCompleted) { return $t.Result }
  return $null
}

function Await($op, [Type]$type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(3000)
  if ($t.IsCompleted) { return $t.Result }
  return $null
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]

$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($mgrType::RequestAsync()) $mgrType
if ($null -eq $mgr) { [Console]::Out.WriteLine('{"error":"Could not open Windows media session manager"}'); exit 2 }

$lastThumbKey = @{}   # app -> key we already have a picture for
$thumbTries = @{}     # key -> attempts (apps often attach the picture a moment late)
$thumbSeq = 0
$script:thumbErr = $null
$thumbFolder = $null
if ($ThumbDir) {
  try { $thumbFolder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($ThumbDir)) ([Windows.Storage.StorageFolder]) } catch { $script:thumbErr = "folder: $($_.Exception.Message)" }
}

# PowerShell only sees methods declared directly on a WinRT object's own interface, so
# calls like $ras.GetInputStreamAt() fail ("__ComObject does not contain a method...").
# Passing the object as an argument works, because WinRT converts it to the interface.
function Get-InputStream($ras) {
  try { return [Windows.Storage.Streams.IRandomAccessStream].GetMethod('GetInputStreamAt').Invoke($ras, @([uint64]0)) } catch { return $ras }
}

# Method 1: let WinRT copy the stream straight into a temp file.
function Save-ThumbFile($ras) {
  if ($null -eq $thumbFolder) { return $null }
  $script:thumbSeq++
  $name = "thumb-$PID-$($script:thumbSeq).img"
  $file = Await ($thumbFolder.CreateFileAsync($name, [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
  if ($null -eq $file) { throw 'create file failed' }
  $outStream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
  $n = AwaitProg ([Windows.Storage.Streams.RandomAccessStream]::CopyAndCloseAsync((Get-InputStream $ras), $outStream)) ([uint64]) ([uint64])
  try { $outStream.Dispose() } catch {}
  if (-not $n) { throw 'copy returned 0 bytes' }
  return $file.Path
}

# Method 2: DataReader (works without knowing the stream size).
function Read-ThumbBytes($ras) {
  $reader = New-Object Windows.Storage.Streams.DataReader((Get-InputStream $ras))
  $reader.InputStreamOptions = [Windows.Storage.Streams.InputStreamOptions]::Partial
  $total = New-Object System.Collections.Generic.List[byte]
  for ($i = 0; $i -lt 64; $i++) {
    $n = Await ($reader.LoadAsync(262144)) ([uint32])
    if ($null -eq $n -or $n -le 0) { break }
    $buf = $reader.ReadBuffer($n)
    $total.AddRange([System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::ToArray($buf))
  }
  try { $reader.Dispose() } catch {}
  return $total.ToArray()
}

# Returns @{ file = path } or @{ data = data-uri } or $null
function Read-Thumb($props) {
  if ($null -eq $props.Thumbnail) { $script:thumbErr = 'app gave no picture'; return $null }
  $ras = $null
  try {
    $ras = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  } catch { $script:thumbErr = "open: $($_.Exception.Message)"; return $null }
  if ($null -eq $ras) { $script:thumbErr = 'open timed out'; return $null }
  $errs = @()
  try {
    $f = Save-ThumbFile $ras
    if ($f) { $script:thumbErr = $null; return @{ file = $f } }
  } catch { $errs += "copy: $($_.Exception.Message)" }
  try {
    $bytes = Read-ThumbBytes $ras
    if ($bytes.Length -gt 0) { $script:thumbErr = $null; return @{ data = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes) } }
    $errs += 'reader: 0 bytes'
  } catch { $errs += "reader: $($_.Exception.Message)" }
  try {
    $s = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead((Get-InputStream $ras))
    $ms = New-Object System.IO.MemoryStream
    $s.CopyTo($ms); $bytes = $ms.ToArray(); $s.Dispose(); $ms.Dispose()
    if ($bytes.Length -gt 0) { $script:thumbErr = $null; return @{ data = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes) } }
  } catch { $errs += "stream: $($_.Exception.Message)" }
  $script:thumbErr = ($errs -join '; ')
  return $null
}

function Run-Command($cmd) {
  if ($cmd.action -eq 'rate') { $script:RateMs = [Math]::Max(250, [int]$cmd.ms); return }
  foreach ($s in $mgr.GetSessions()) {
    if ($cmd.app -and $s.SourceAppUserModelId -ne $cmd.app) { continue }
    switch ($cmd.action) {
      'toggle'   { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
      'play'     { [void](Await ($s.TryPlayAsync()) ([bool])) }
      'pause'    { [void](Await ($s.TryPauseAsync()) ([bool])) }
      'next'     { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
      'previous' { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
      'seek'     { [void](Await ($s.TryChangePlaybackPositionAsync([long]([double]$cmd.positionMs * 10000))) ([bool])) }
    }
    break
  }
}

$tick = 0
$lastEmit = [DateTime]::MinValue
$pendingThumb = $false
while ($true) {
  $ranCmd = $false
  if ($CmdFile -and (Test-Path -LiteralPath $CmdFile)) {
    # One file per command so quick presses never overwrite each other.
    foreach ($f in (Get-ChildItem -LiteralPath $CmdFile -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
      try {
        $raw = [System.IO.File]::ReadAllText($f.FullName)
        Remove-Item -LiteralPath $f.FullName -Force
        Run-Command (ConvertFrom-Json $raw)
        $ranCmd = $true
      } catch {}
    }
  }

  $due = ((Get-Date) - $lastEmit).TotalMilliseconds -ge $script:RateMs
  $retryThumb = $pendingThumb -and ((Get-Date) - $lastEmit).TotalMilliseconds -ge 900
  if ($ranCmd -or $due -or $retryThumb) {
    $lastEmit = Get-Date
    $pendingThumb = $false
    $out = New-Object System.Collections.ArrayList
    $current = $null
    try {
      $cur = $mgr.GetCurrentSession()
      if ($cur) { $current = $cur.SourceAppUserModelId }
      foreach ($s in $mgr.GetSessions()) {
        try {
          $app = $s.SourceAppUserModelId
          $props = Await ($s.TryGetMediaPropertiesAsync()) $propType
          if ($null -eq $props) { continue }
          $pb = $s.GetPlaybackInfo()
          $tl = $s.GetTimelineProperties()
          $key = "$app|$($props.Title)|$($props.Artist)"
          $thumb = $null; $thumbFile = $null
          if ($lastThumbKey[$app] -ne $key -and [int]$thumbTries[$key] -lt 8) {
            $thumbTries[$key] = [int]$thumbTries[$key] + 1
            $r = Read-Thumb $props
            if (-not $r) { $pendingThumb = $true }
            if ($r) {
              $lastThumbKey[$app] = $key
              if ($r.file) { $thumbFile = $r.file } else { $thumb = $r.data }
            }
          }
          $end = $tl.EndTime.TotalMilliseconds
          $start = $tl.StartTime.TotalMilliseconds
          [void]$out.Add([ordered]@{
            app         = $app
            title       = $props.Title
            artist      = $props.Artist
            album       = $props.AlbumTitle
            albumArtist = $props.AlbumArtist
            status      = $pb.PlaybackStatus.ToString()
            canNext     = $pb.Controls.IsNextEnabled
            canPrev     = $pb.Controls.IsPreviousEnabled
            canSeek     = $pb.Controls.IsPlaybackPositionEnabled
            positionMs  = [long]($tl.Position.TotalMilliseconds - $start)
            durationMs  = [long]($end - $start)
            updatedAt   = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
            thumbKey    = $key
            thumb       = $thumb
            thumbFile   = $thumbFile
          })
        } catch {}
      }
    } catch {}
    $json = ConvertTo-Json -Compress -Depth 4 ([ordered]@{ now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); current = $current; thumbErr = $script:thumbErr; sessions = @($out) })
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
  $tick++
  Start-Sleep -Milliseconds 300
}
