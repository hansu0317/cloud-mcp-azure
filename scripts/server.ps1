# CRM Chat 서버 관리 스크립트 (Windows / PowerShell 버전)
# scripts/server.sh(Linux)와 동일한 역할 - start/stop/restart/status
#
# 사용법:
#   powershell -ExecutionPolicy Bypass -File scripts\server.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts\server.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts\server.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\server.ps1 restart

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

# 콘솔 코드페이지가 UTF-8(65001)이 아니면 한글 로그가 깨져 보인다 (CP949로 잘못 해석됨).
# app.log 자체는 항상 정상 UTF-8이므로, 표시 쪽만 맞춰준다.
try {
    if ((chcp) -notmatch '65001') { chcp 65001 | Out-Null }
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
} catch {
    # 콘솔이 없는 호스트(예: 스케줄러) 등에서는 무시
}

$AppDir     = Split-Path -Parent $PSScriptRoot
$PidFile    = Join-Path $AppDir '.server.pid'
$LogDir     = Join-Path $AppDir 'logs'
$ConsoleLog = Join-Path $LogDir 'console.log'   # 서버 프로세스의 원시 stdout+stderr (앱 자체 로그는 별도 app.log)
$Port       = 3000

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

function Get-ServerProcess {
    if (Test-Path $PidFile) {
        $storedId = Get-Content $PidFile -ErrorAction SilentlyContinue
        if ($storedId) {
            $p = Get-Process -Id $storedId -ErrorAction SilentlyContinue
            if ($p) {
                return $p
            }
        }
    }
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    }
    return $null
}

function Start-Server {
    $existing = Get-ServerProcess
    if ($existing) {
        Write-Host "[WARN] server is already running (PID: $($existing.Id))"
        exit 1
    }

    Write-Host "[BUILD] building frontend..."
    Push-Location $AppDir
    try {
        # PowerShell 5.1: redirecting a native command's stderr (2>&1 / *>>) wraps each
        # line as a terminating NativeCommandError under $ErrorActionPreference='Stop',
        # even on exit code 0 (e.g. Vite's harmless deprecation warning). So run it
        # un-redirected here and only check the real exit code.
        npm run build:client
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] frontend build failed (exit $LASTEXITCODE)"
            exit 1
        }

        Write-Host "[START] starting server..."
        # Start-Process -RedirectStandardOutput/-RedirectStandardError refuse to share one
        # file, so stdout+stderr are merged into a single console.log via cmd.exe's own
        # redirection instead (runs outside PowerShell's stream machinery entirely).
        Remove-Item $ConsoleLog -ErrorAction SilentlyContinue
        $cmdLine = 'npx.cmd tsx server/index.ts >> "' + $ConsoleLog + '" 2>&1'
        $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdLine) `
            -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru
    }
    finally {
        Pop-Location
    }

    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    Start-Sleep -Seconds 2

    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Write-Host "[OK] server started (PID: $($proc.Id))"
        Write-Host "     http://localhost:$Port"
        Write-Host "     console log: $ConsoleLog"
        Write-Host "     app log:     $LogDir\app.log"
    }
    else {
        Write-Host "[FAIL] server failed to start, see log:"
        Get-Content $ConsoleLog -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        exit 1
    }
}

function Stop-Server {
    $p = Get-ServerProcess
    if (-not $p) {
        Write-Host "[WARN] no server running"
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        return
    }

    Write-Host "[STOP] stopping server... (PID: $($p.Id))"
    taskkill /F /T /PID $p.Id 2>&1 | Out-Null
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "[OK] server stopped"
}

function Show-Status {
    $p = Get-ServerProcess
    if ($p) {
        Write-Host "[OK] server running (PID: $($p.Id))"
        Write-Host "     http://localhost:$Port"
        if (-not (Test-Path $PidFile) -or (Get-Content $PidFile -ErrorAction SilentlyContinue) -ne $p.Id) {
            Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
            Write-Host "     [WARN] pid file regenerated ($PidFile)"
        }
        $AppLog = Join-Path $LogDir 'app.log'
        if (Test-Path $AppLog) {
            Write-Host ""
            Write-Host "-- recent app.log --"
            Get-Content $AppLog -Tail 5 -Encoding UTF8
        }
    }
    else {
        Write-Host "[STOPPED] server is not running"
        Remove-Item $PidFile -ErrorAction SilentlyContinue
    }
}

function Show-Logs {
    $AppLog = Join-Path $LogDir 'app.log'
    if (-not (Test-Path $AppLog)) {
        Write-Host "로그 파일 없음: $AppLog"
        return
    }
    Write-Host "-- app.log (Ctrl+C로 종료) --"
    # -Encoding UTF8을 빼먹으면 시스템 기본 코드페이지(CP949 등)로 읽어 한글이 깨진다.
    Get-Content $AppLog -Tail 20 -Wait -Encoding UTF8
}

switch ($Action) {
    'start'   { Start-Server }
    'stop'    { Stop-Server }
    'status'  { Show-Status }
    'restart' { Stop-Server; Start-Sleep -Seconds 1; Start-Server }
    'logs'    { Show-Logs }
}
