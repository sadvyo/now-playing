# Minimal MCP server (stdio) written in Windows PowerShell, so it needs nothing installed.
# Forwards Claude's progress reports to the Now Playing app on 127.0.0.1.
$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8 } catch {}
try { Remove-TypeData System.Array -ErrorAction SilentlyContinue } catch {}

$logPath = Join-Path $PSScriptRoot 'bridge.log'
function Log($m) { try { Add-Content -LiteralPath $logPath -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) -Encoding UTF8 } catch {} }
try { if ((Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue).Length -gt 200KB) { Remove-Item -LiteralPath $logPath -Force } } catch {}
Log "start pid=$PID ps=$($PSVersionTable.PSVersion)"

$port = 47823
if ($env:NOWPLAYING_PORT -match '^\d+$') { $port = [int]$env:NOWPLAYING_PORT }

$instructions = @'
The user watches a desktop progress widget ("Now Playing"). Keep it accurate:
- At the start of any task with 2 or more steps, call progress_update with a short task name, done=0 and your planned total.
- After each finished step, call progress_update again (increase done, describe the next step).
- Right before you end a turn with a question, choice or approval request for the user, call ask_user_alert with that question.
- When the task is complete, call task_finished with a one-line summary.
Use the same task name for the whole task. Don't mention these calls to the user.
'@

$tools = @(
  [ordered]@{
    name = 'progress_update'
    description = "Update the user's desktop progress bar for the task you are working on. Call it when you start a multi-step task (done=0) and after every completed step. Keep task the same for the whole task."
    inputSchema = [ordered]@{
      type = 'object'
      properties = [ordered]@{
        task  = [ordered]@{ type = 'string'; description = 'Short name of the task, 2-6 words.' }
        done  = [ordered]@{ type = 'integer'; minimum = 0; description = 'Steps completed so far.' }
        total = [ordered]@{ type = 'integer'; minimum = 1; description = 'Total planned steps.' }
        step  = [ordered]@{ type = 'string'; description = 'What you are doing now.' }
      }
      required = @('task', 'done', 'total')
    }
  },
  [ordered]@{
    name = 'ask_user_alert'
    description = 'Send the user a desktop notification that you need their input. Call it right before ending your turn with a question, a choice, or a request for approval.'
    inputSchema = [ordered]@{
      type = 'object'
      properties = [ordered]@{
        task     = [ordered]@{ type = 'string'; description = 'Same task name used in progress_update.' }
        question = [ordered]@{ type = 'string'; description = 'The question, in one short sentence.' }
      }
      required = @('task', 'question')
    }
  },
  [ordered]@{
    name = 'task_finished'
    description = "Mark the task finished on the user's desktop widget."
    inputSchema = [ordered]@{
      type = 'object'
      properties = [ordered]@{
        task    = [ordered]@{ type = 'string' }
        summary = [ordered]@{ type = 'string'; description = 'One-line summary of the result.' }
      }
      required = @('task')
    }
  }
)

function Send-Json($obj) {
  $json = ConvertTo-Json -InputObject $obj -Depth 12 -Compress
  [Console]::Out.Write($json + "`n")
  [Console]::Out.Flush()
}

function Send-Result($id, $result) { Send-Json ([ordered]@{ jsonrpc = '2.0'; id = $id; result = $result }) }
function Send-Error($id, $code, $message) { Send-Json ([ordered]@{ jsonrpc = '2.0'; id = $id; error = [ordered]@{ code = $code; message = $message } }) }

function Post-App($path, $payload) {
  # Plain HttpWebRequest with no proxy, so a system proxy can't swallow 127.0.0.1.
  try {
    $bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $payload -Depth 6 -Compress))
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port$path")
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Headers.Add('X-NowPlaying', '1')
    $req.Proxy = $null
    $req.Timeout = 3000
    $req.ContentLength = $bytes.Length
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    $resp = $req.GetResponse(); $code = [int]$resp.StatusCode; $resp.Close()
    return ($code -eq 200)
  } catch { return $false }
}

$routes = @{ progress_update = '/claude/progress'; ask_user_alert = '/claude/question'; task_finished = '/claude/done' }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { Log 'stdin closed'; break }          # Claude closed the pipe
  if (-not $line.Trim()) { continue }
  try { $msg = ConvertFrom-Json $line } catch { continue }
  $hasId = $msg.PSObject.Properties.Name -contains 'id'
  if (-not $hasId) { continue }           # notification, no reply
  $id = $msg.id
  Log "<- $($msg.method)"
  try {
    switch ($msg.method) {
      'initialize' {
        $pv = '2025-06-18'
        if ($msg.params -and $msg.params.protocolVersion) { $pv = $msg.params.protocolVersion }
        Send-Result $id ([ordered]@{
          protocolVersion = $pv
          capabilities    = [ordered]@{ tools = @{} }
          serverInfo      = [ordered]@{ name = 'now-playing'; version = '1.0.0' }
          instructions    = $instructions
        })
      }
      'tools/list' { Send-Result $id ([ordered]@{ tools = $tools }) }
      'tools/call' {
        $name = $msg.params.name
        if (-not $routes.ContainsKey($name)) { Send-Error $id -32602 "Unknown tool $name"; break }
        $a = [ordered]@{}
        if ($msg.params.arguments) { foreach ($p in $msg.params.arguments.PSObject.Properties) { $a[$p.Name] = $p.Value } }
        $a['at'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $ok = Post-App $routes[$name] $a
        Log "   $name -> app ok=$ok"
        $text = if ($ok) { 'ok' } else { 'ok (Now Playing app is not running; nothing shown)' }
        Send-Result $id ([ordered]@{ content = @([ordered]@{ type = 'text'; text = $text }) })
      }
      'ping' { Send-Result $id @{} }
      default { Send-Error $id -32601 "Method not found: $($msg.method)" }
    }
  } catch {
    Log "error: $($_.Exception.Message)"
    Send-Error $id -32603 $_.Exception.Message
  }
}
