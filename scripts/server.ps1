# Quali CRM AI Notebook FastAPI server management (Windows)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\server.ps1 start|stop|restart|status|logs

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
try {
    if ((chcp) -notmatch '65001') { chcp 65001 | Out-Null }
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
} catch {}

$AppDir = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $AppDir '.env'
$PidFile = Join-Path $AppDir '.server.pid'
$LogDir = Join-Path $AppDir 'logs'

function Get-DotEnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $null }
    foreach ($line in Get-Content -LiteralPath $EnvFile -ErrorAction Stop) {
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
        if ($Matches[1] -ne $Name) { continue }
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2) {
            $first = $value.Substring(0, 1); $last = $value.Substring($value.Length - 1, 1)
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                return $value.Substring(1, $value.Length - 2)
            }
        }
        return [regex]::Replace($value, '\s+#.*$', '').Trim()
    }
    return $null
}

function Resolve-Setting {
    param([Parameter(Mandatory = $true)][string]$Name)
    $processValue = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($processValue)) { return $processValue.Trim() }
    return Get-DotEnvValue -Name $Name
}

$PortRaw = Resolve-Setting -Name 'PORT'
if ([string]::IsNullOrWhiteSpace($PortRaw)) { $PortRaw = '3000' }
$Port = 0
if (-not [int]::TryParse($PortRaw, [ref]$Port) -or $Port -lt 1 -or $Port -gt 65535) {
    throw "Invalid PORT '$PortRaw'."
}

$ProviderRaw = Resolve-Setting -Name 'LLM_PROVIDER'
if ([string]::IsNullOrWhiteSpace($ProviderRaw)) { $ProviderRaw = 'anthropic' }
$Provider = $ProviderRaw.Trim().ToLowerInvariant()
switch ($Provider) {
    'anthropic' { $Profile = 'cloud' }
    'ollama' { $Profile = 'local' }
    default { throw "Invalid LLM_PROVIDER '$ProviderRaw'. Use anthropic or ollama." }
}

$StructuredLog = Join-Path $LogDir ("server.{0}.log" -f $Profile)
$VenvPython = Join-Path $AppDir '.venv\Scripts\python.exe'
$PythonExe = if (Test-Path -LiteralPath $VenvPython) { $VenvPython } else { 'python' }

function Resolve-BoundedInt {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Default,
        [Parameter(Mandatory = $true)][int]$Minimum,
        [Parameter(Mandatory = $true)][int]$Maximum
    )
    $raw = Resolve-Setting -Name $Name
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $parsed = 0
    if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt $Minimum -or $parsed -gt $Maximum) {
        throw "Invalid $Name '$raw' (allowed: $Minimum..$Maximum)."
    }
    return $parsed
}

$StartTimeout = Resolve-BoundedInt -Name 'SERVER_START_TIMEOUT_SECONDS' -Default 30 -Minimum 1 -Maximum 300
$StopTimeout = Resolve-BoundedInt -Name 'SERVER_STOP_TIMEOUT_SECONDS' -Default 30 -Minimum 1 -Maximum 300

function Get-OwnedServerProcess {
    param([Parameter(Mandatory = $true)][int]$CandidateId)
    $process = Get-Process -Id $CandidateId -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $CandidateId" -ErrorAction Stop
        $commandLine = [string]$processInfo.CommandLine
        if ($commandLine -notmatch '(?i)(?:^|\s)-m\s+backend\.main(?:\s|$)') { return $null }
    } catch {
        return $null
    }
    return $process
}

function Get-ServerProcess {
    if (Test-Path -LiteralPath $PidFile) {
        $storedText = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
        $storedId = 0
        if ([int]::TryParse($storedText, [ref]$storedId)) {
            $process = Get-OwnedServerProcess -CandidateId $storedId
            if ($process) { return $process }
        }
    }
    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) {
        $process = Get-OwnedServerProcess -CandidateId $connection.OwningProcess
        if ($process) { return $process }
        throw "Port $Port is occupied by a process that is not this FastAPI server; refusing to manage it."
    }
    return $null
}

function Start-Server {
    $existing = Get-ServerProcess
    if ($existing) { Write-Host "[WARN] server already running (PID: $($existing.Id))"; exit 1 }
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

    Push-Location $AppDir
    try {
        Write-Host '[BUILD] building React client...'
        npm run build:client
        if ($LASTEXITCODE -ne 0) { throw "Frontend build failed (exit $LASTEXITCODE)." }
        Write-Host "[START] starting FastAPI $Profile profile ($Provider)..."
        $process = Start-Process -FilePath $PythonExe -ArgumentList @('-m', 'backend.main') -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru
    } finally { Pop-Location }

    Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $StartTimeout) {
        if (-not (Get-OwnedServerProcess -CandidateId $process.Id)) { break }
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $process.Id } | Select-Object -First 1
        if ($listener) {
            Write-Host "[OK] FastAPI server started (PID: $($process.Id))"
            Write-Host "     profile: $Profile ($Provider)"
            Write-Host "     url: http://localhost:$Port"
            Write-Host "     structured log: $StructuredLog"
            return
        }
        Start-Sleep -Milliseconds 250
    }
    Write-Host "[FAIL] server did not listen on port $Port within ${StartTimeout}s:"
    Get-Content -LiteralPath $StructuredLog -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue
    $owned = Get-OwnedServerProcess -CandidateId $process.Id
    if ($owned) { Stop-Process -Id $owned.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    exit 1
}

function Stop-Server {
    $process = Get-ServerProcess
    if (-not $process) { Write-Host '[WARN] no server running'; Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue; return }
    Write-Host "[STOP] stopping server (PID: $($process.Id))..."
    # taskkill writes to stderr whenever any process in the tree can't be closed
    # gracefully without /F (routine for a hidden, windowless `-WindowStyle Hidden`
    # process/child — Windows has no window to send WM_CLOSE to). Do NOT route that
    # through PowerShell's error stream (2>&1 / 2>$null / *>): under this script's
    # $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 wraps a native command's
    # redirected stderr into a terminating ErrorRecord, which aborted this function
    # right here before it ever reached the timeout/force-kill fallback below. Leaving
    # stderr unredirected prints it as plain informational text instead.
    taskkill /T /PID $process.Id | Out-Null
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $StopTimeout -and (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-OwnedServerProcess -CandidateId $process.Id) {
        Write-Host "[WARN] graceful stop timed out after ${StopTimeout}s; force-killing owned process tree."
        # Stop-Process only targets this single PID, not its children — a child that
        # survived the graceful taskkill above (like the one that triggered this fix)
        # would otherwise be orphaned. Force + tree kill covers that.
        taskkill /F /T /PID $process.Id | Out-Null
    }
    Remove-Item -LiteralPath $PidFile -ErrorAction SilentlyContinue
    Write-Host '[OK] server stopped'
}

function Show-Status {
    $process = Get-ServerProcess
    if (-not $process) { Write-Host '[STOPPED] server is not running'; return }
    Write-Host "[OK] FastAPI server running (PID: $($process.Id))"
    Write-Host "     profile: $Profile ($Provider)"
    Write-Host "     url: http://localhost:$Port"
    Write-Host "     structured log: $StructuredLog"
}

function Show-Logs {
    if (-not (Test-Path -LiteralPath $StructuredLog)) { Write-Host "Log file not found: $StructuredLog"; return }
    Get-Content -LiteralPath $StructuredLog -Tail 20 -Wait -Encoding UTF8
}

switch ($Action) {
    'start' { Start-Server }
    'stop' { Stop-Server }
    'restart' { Stop-Server; Start-Sleep -Seconds 1; Start-Server }
    'status' { Show-Status }
    'logs' { Show-Logs }
}
